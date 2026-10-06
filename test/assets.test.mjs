// assets.test.mjs - pins the two hand-maintained asset lists (service-worker.js
// ASSETS and main.js UPDATE_FINGERPRINT_ASSETS) to main.js's import graph.
// Run with:  node --test
// No framework, no dependencies (uses the built-in node:test runner).
// Source scans, not behavior tests: neither file can be imported here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { CHARGER_KEYS, defaultPrefs, hasChargerInput } from "../js/storage.js";
import { effectivePerKwh } from "../js/cardUi.js";
import { rateAtTime, rateAtElapsed } from "../js/calc.js";
import { parseNum } from "../js/ui.js";

const REPO = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// A commented-out import must not pull a module into the graph, and a
// commented-out list entry must not count as shipped. The line case spares a
// "://", which is the one place a protocol looks like a comment.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

// Every import form this bundle-free build can use: bare side-effect imports,
// re-exports, either quote, dynamic import(), and paths into a subfolder. A
// form that escapes this leaves its module out of BOTH lists with nothing red.
const IMPORT_RE = /\b(?:import|from)\s*\(?\s*["'](\.{1,2}\/[^"']+\.js)["']/g;

// Walked rather than restated, so a module added anywhere is covered for free.
// Each specifier resolves against the file that imported it, not against js/.
function moduleGraph() {
  const entry = new URL("js/main.js", REPO);
  const seen = new Set([entry.href]);
  const queue = [entry];
  while (queue.length) {
    const from = queue.pop();
    for (const m of stripComments(readFileSync(from, "utf8")).matchAll(IMPORT_RE)) {
      const next = new URL(m[1], from);
      if (!seen.has(next.href)) { seen.add(next.href); queue.push(next); }
    }
  }
  return [...seen].map((href) => `./${href.slice(REPO.href.length)}`).sort();
}

// The string entries of a top-level array literal, read out of source.
function listedIn(src, name) {
  const start = src.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `${name} moved or was renamed`);
  const end = src.indexOf("];", start);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return [...stripComments(src.slice(start, end)).matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

const modulesIn = (listed) => listed.filter((u) => u.endsWith(".js")).sort();

test("the import scan covers every form an import can take", () => {
  // Guard on the guard: each of these slipped past the old pattern, and a
  // module reached only that way was in neither list with nothing going red.
  const forms = {
    "a named import": 'import { a } from "./plain.js";',
    "a side-effect import with no from clause": 'import "./sideEffect.js";',
    "a single-quoted specifier": "import x from './single.js';",
    "a dynamic import": 'const m = await import("./lazy.js");',
    "a path into a subfolder": 'import { a } from "./sub/deep.js";',
    "a re-export": 'export { b } from "./again.js";',
  };
  for (const [what, line] of Object.entries(forms)) {
    assert.equal([...line.matchAll(IMPORT_RE)].length, 1, `${what} is invisible to the import scan`);
  }
  const commented = stripComments('// import { a } from "./gone.js";');
  assert.deepEqual([...commented.matchAll(IMPORT_RE)], [], "a commented-out import still counts as real");
});

test("the import scan finds the whole module graph", () => {
  // Guard on the guard: a regex that stopped matching would pass everything below.
  const modules = moduleGraph();
  assert.ok(modules.length >= 12, `only ${modules.length} modules found: the import scan broke`);
  for (const expected of ["./js/main.js", "./js/myCars.js", "./js/dropdown.js"]) {
    assert.ok(modules.includes(expected), `${expected} missing from the scan`);
  }
});

// Column zero stands in for module scope: every function body in this build is indented.
function topLevelSegmenterLines(src) {
  return stripComments(src).split("\n").filter((l) => /^\S/.test(l) && l.includes("new Intl.Segmenter"));
}

// A Segmenter built at module scope is a blank page on an old engine, not a degraded feature.
test("no module builds an Intl.Segmenter at evaluation time", () => {
  // Guard on the guard: both shapes have to be told apart, or this passes everything.
  assert.equal(topLevelSegmenterLines('const G = new Intl.Segmenter();').length, 1);
  assert.equal(topLevelSegmenterLines('function f() {\n  return new Intl.Segmenter();\n}').length, 0);

  for (const rel of moduleGraph()) {
    assert.deepEqual(
      topLevelSegmenterLines(readFileSync(new URL(rel, REPO), "utf8")),
      [],
      `${rel} constructs an Intl.Segmenter at module scope: build it on first use behind a guard`,
    );
  }
});

const atCalls = (src) => stripComments(src).match(/\.at\(/g) ?? [];

// Array.prototype.at is Firefox 90 and Safari 15.4, both newer than this build
// supports. A missing method throws where it is CALLED, so unlike the Segmenter
// there is no scope that makes it safe and the ban is whole-file. The one use
// sat in the shared keydown handler AHEAD of that handler's own bail-out, so on
// an older engine every keystroke anywhere on the page threw, open menu or not.
test("no module calls Array.prototype.at", () => {
  // Guard on the guard: the dot is what tells the method from a name ending in it.
  assert.equal(atCalls("const d = [...openMenus].at(-1);").length, 1);
  assert.equal(atCalls("const n = items.concat(rest);").length, 0);
  assert.equal(atCalls("// index arithmetic, not .at(-1)").length, 0);

  for (const rel of moduleGraph()) {
    assert.deepEqual(
      atCalls(readFileSync(new URL(rel, REPO), "utf8")),
      [],
      `${rel} calls .at(), which throws on Safari < 15.4 and Firefox < 90: index from length instead`,
    );
  }
});

// A top-level function's body. Every function body in this build is indented,
// so a `}` in column zero is the end of one.
function bodyOf(src, name) {
  const s = stripComments(src);
  const start = s.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} moved or was renamed`);
  return s.slice(start, s.indexOf("\n}", start));
}

// <dialog> is Firefox 98 and Safari 15.4. showModal() is only reached from a
// click, so a missing method costs one control rather than the page, but it
// cost it SILENTLY: no question asked, no car removed, no reason given. The
// feature test alone is not the fix, because bailing out is that same silence.
// The confirm is what keeps the control working, so both halves are pinned.
//
// Read as a GATE inside the function that asks, not as two substrings anywhere
// in the file. Unscoped, any unrelated window.confirm( in main.js stood in for
// this one, and a confirm whose answer was taken and then ignored counted as a
// working fallback.
function dialogFallback(src, asker, act) {
  const body = bodyOf(src, asker);
  if (!/typeof\s+\w+\.showModal\s*!==\s*["']function["']/.test(body)) return false;
  // The answer has to be SPENT: the act inside the yes branch, or after a
  // refusal that returns. A refusal that falls through is Cancel acting anyway.
  const asked = String.raw`window\.confirm\((?:[^()]|\([^()]*\))*\)`;
  if (new RegExp(String.raw`if\s*\(\s*${asked}\s*\)\s*(?:\{[^{}]*)?\b${act}\(\)`).test(body)) return true;
  const refused = new RegExp(String.raw`if\s*\(\s*!\s*${asked}\s*\)\s*(?:return\b|\{[^{}]*\breturn\s*;?\s*\})`).exec(body);
  return refused !== null && body.includes(`${act}()`, refused.index + refused[0].length);
}

test("the remove and reset controls still work on engines without <dialog>", () => {
  const ask = (lines) => `function askRemoveCar() {\n${lines}\n}\n`;
  const removal = (src) => dialogFallback(src, "askRemoveCar", "removeActiveCar");

  // Guard on the guard: a bare call, and a feature test that bails rather than asks.
  assert.equal(removal(ask("  dlg.showModal();")), false);
  assert.equal(removal(ask('  if (typeof dlg.showModal !== "function") return;')), false);

  // One that ASKS and throws the answer away, which the old substring pair
  // passed: the question is drawn, "Keep it" is pressed, the car goes anyway.
  assert.equal(
    removal(ask('  if (typeof dlg.showModal !== "function") {\n    window.confirm(q);\n    removeActiveCar();\n  }')),
    false,
  );

  // And a confirm belonging to a different control, which is exactly what an
  // unscoped scan could not tell from this one.
  const elsewhere = "function resetEverything() {\n  if (window.confirm(q)) removeActiveCar();\n}\n";
  assert.equal(removal(elsewhere + ask('  if (typeof dlg.showModal !== "function") return;')), false);

  // Both gating shapes pass: the answer spent where it is taken, and the
  // refusal taken as an early return.
  const sound = ask('  if (typeof dlg.showModal !== "function") {\n    if (!window.confirm(q)) return;\n    removeActiveCar();\n  }');
  assert.equal(
    removal(ask('  if (typeof dlg.showModal !== "function") {\n    if (window.confirm(q)) removeActiveCar();\n  }')),
    true,
  );
  assert.equal(removal(sound), true);

  // A refusal that counts the "no" and falls through to the act, which is
  // Cancel resetting anyway: askReset's refusal block with its return dropped.
  const resetAsker = (refusal) =>
    `function askReset() {\n  if (typeof dlg.showModal !== "function") {\n${refusal}    resetEverything();\n    return;\n  }\n}\n`;
  const reset = (src) => dialogFallback(src, "askReset", "resetEverything");
  const kept = '      trackWhenReady("reset-kept");\n';
  assert.equal(reset(resetAsker(`    if (!window.confirm(q)) {\n${kept}    }\n`)), false);
  assert.equal(reset(resetAsker('    if (!window.confirm(q)) trackWhenReady("reset-kept");\n')), false);
  assert.equal(reset(resetAsker(`    if (!window.confirm(q)) {\n${kept}      return;\n    }\n`)), true);

  // And the asker named is the one read: a sound askRemoveCar must not vouch
  // for an askReset that has no fallback at all.
  const bare = "function askReset() {\n  dlg.showModal();\n}\n";
  assert.equal(dialogFallback(sound + bare, "askReset", "resetEverything"), false);

  const src = read("../js/main.js");
  for (const [asker, act] of [["askRemoveCar", "removeActiveCar"], ["askReset", "resetEverything"]]) {
    assert.equal(
      dialogFallback(src, asker, act),
      true,
      `${asker} reaches showModal() with no confirm gating ${act}(): below Firefox 98 / Safari 15.4 the control does nothing, or acts on Cancel`,
    );
  }
});

// --- Analytics --------------------------------------------------------------

// The first argument of every track() / trackWhenReady() call, read with a
// balanced scan so a nested call or a ${} cannot end the argument early. The
// two declarations in analytics.js are matched too, harmlessly: their parameter
// is a plain name like any other.
function trackArgs(src) {
  const s = stripComments(src);
  const args = [];
  for (const m of s.matchAll(/\b(?:track|trackWhenReady)\s*\(/g)) {
    const from = m.index + m[0].length;
    let depth = 1;
    let i = from;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === "," && depth === 1) break;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c) && --depth === 0) break;
    }
    args.push(s.slice(from, i).trim());
  }
  return args;
}

// A ternary BETWEEN LITERALS is safe and already used twice (the pricing mode
// and the verdict). A backtick or a + is the other thing entirely: the only
// reason to build a name rather than write one is to put a value in it, and the
// values in reach here are the user's car and the user's numbers.
const leakyTrackArgs = (src) => trackArgs(src).filter((a) => a.includes("`") || a.includes("+"));

test("source guard: no analytics event name is built out of user data", () => {
  // Guard on the guard: the two safe shapes have to pass and the two that leak
  // have to be caught, or this scan says nothing.
  assert.deepEqual(leakyTrackArgs('track("car-selected");'), []);
  assert.deepEqual(leakyTrackArgs('track(rateMode === "dur" ? "mode-by-duration" : "mode-flat");'), []);
  assert.deepEqual(leakyTrackArgs("track(`car-${name}`);"), ["`car-${name}`"]);
  assert.deepEqual(leakyTrackArgs('track("car-" + name);'), ['"car-" + name']);

  const calls = trackArgs(read("../js/main.js"));
  assert.ok(calls.length >= 15, `only ${calls.length} track calls found in main.js: the call scan broke`);

  for (const rel of moduleGraph()) {
    assert.deepEqual(
      leakyTrackArgs(readFileSync(new URL(rel, REPO), "utf8")),
      [],
      `${rel} builds an event name instead of writing one: the name is the whole of what GoatCounter is sent, so a car name inside it is a car name published`,
    );
  }
});

test("source guard: the switch a removal performs is not counted as a user switching cars", () => {
  // Guard on the guard: one sample proves both halves, that the scan sees
  // inside the function it names and that it stops at the end of it.
  const two = 'function a() {\n  const x = 1;\n}\nfunction b() {\n  t("cars-switched");\n}\n';
  assert.match(bodyOf(two, "b"), /cars-switched/, "the body scan cannot see the call it is looking for");
  assert.doesNotMatch(bodyOf(two, "a"), /cars-switched/, "the body scan runs past the end of the function it names");

  // switchToMyCar has three callers and one of them is removeActiveCar, landing
  // the user on the neighbouring car after a removal. That is the app choosing
  // a car, so the event lives at the two call sites a user actually reaches.
  assert.doesNotMatch(
    bodyOf(read("../js/main.js"), "switchToMyCar"),
    /cars-switched/,
    "cars-switched moved inside switchToMyCar, so every removal now reports a switch the user never made",
  );
});

test("source guard: the saved-cars and reset events are all still sent", () => {
  // A positive match, unlike the bans above, because here the literal IS the
  // metric: a renamed event is not a broken test, it is a series that stops in
  // GoatCounter and a new one that starts with no history. The reset pair is
  // read as a ratio, kept against reset, so losing either one loses both.
  const src = stripComments(read("../js/main.js"));
  const names = [
    "cars-added", "cars-second-added", "cars-copy-added", "cars-switched", "storage-refused",
    "reset-everything", "reset-kept",
  ];
  for (const name of names) {
    assert.ok(src.includes(`"${name}"`), `${name} is no longer sent from main.js, so its series stops in GoatCounter`);
  }
});

test("every listed asset resolves on disk", () => {
  // ASSETS feeds cache.addAll, which rejects the whole install on a single 404,
  // so one typo in a non-JS path silently turns offline mode off.
  const lists = {
    "service-worker.js ASSETS": listedIn(read("../service-worker.js"), "ASSETS"),
    "main.js UPDATE_FINGERPRINT_ASSETS": listedIn(read("../js/main.js"), "UPDATE_FINGERPRINT_ASSETS"),
  };
  for (const [name, paths] of Object.entries(lists)) {
    assert.ok(paths.length >= 12, `${name} came back with ${paths.length} entries: the list scan broke`);
    for (const p of paths) {
      assert.ok(existsSync(new URL(p, REPO)), `${name} lists ${p}, which is not in the repo`);
    }
  }
});

test("the update check fingerprints every module main.js reaches", () => {
  const listed = listedIn(read("../js/main.js"), "UPDATE_FINGERPRINT_ASSETS");
  assert.deepEqual(
    modulesIn(listed),
    moduleGraph(),
    "a module missing here means a release that only changed it raises no refresh toast",
  );
});

test("the service worker caches every module main.js reaches", () => {
  const listed = listedIn(read("../service-worker.js"), "ASSETS");
  assert.deepEqual(
    modulesIn(listed),
    moduleGraph(),
    "a module missing here means a cold offline install stops on an import that resolves to nothing",
  );
});

// ASSETS alone carries the install shell: the navigation target, the PWA
// manifest and the icon. None is fetched as text, so none can be fingerprinted.
const SHELL_ONLY = ["./", "./manifest.json", "./icons/icon.svg"];

test("the two lists agree with each other about everything but the shell", () => {
  // Non-JS entries are pinned here or nowhere: the module graph cannot reach a
  // stylesheet or a dataset, so dropping one from either list went unnoticed.
  const fingerprint = listedIn(read("../js/main.js"), "UPDATE_FINGERPRINT_ASSETS");
  const cached = listedIn(read("../service-worker.js"), "ASSETS");
  assert.deepEqual(
    cached.filter((u) => !SHELL_ONLY.includes(u)).sort(),
    [...fingerprint].sort(),
    "an asset is cached offline but never fingerprinted, or fingerprinted but not cached",
  );
});

// The 1 to 2 transition, not the "has two cars" state. A range re-fires on
// every later add, so the count only ever rises and real adoption cannot be
// told from accumulated state after the fact. One character is the whole
// difference, and the presence guard above cannot see it.
const secondCarLine = (src) =>
  bodyOf(src, "addCurrentCar").split("\n").find((l) => l.includes("cars-second-added")) ?? "";

test("source guard: the second-car event counts the act, not the state", () => {
  // Guard on the guard: the two spellings have to be told apart, or this passes
  // the one case it exists to catch.
  const wrap = (cond) => `function addCurrentCar() {\n  if (next.cars.length ${cond}) t("cars-second-added");\n}\n`;
  assert.match(secondCarLine(wrap("=== 2")), /===\s*2/);
  assert.doesNotMatch(secondCarLine(wrap(">= 2")), /===\s*2/);

  const line = secondCarLine(read("../js/main.js"));
  assert.notEqual(line, "", "cars-second-added left addCurrentCar");
  assert.match(
    line,
    /===\s*2/,
    "cars-second-added is hung on a range rather than the 1 to 2 transition, so it re-fires on every later add and the series stops meaning what it says",
  );
});

// Below Firefox 98 and Safari 15.4 a <dialog> is an unknown INLINE element, so
// it never picks up the UA stylesheet's display:none and the question and both
// its buttons are drawn down the page at all times. Hung off [open], which
// showModal sets and close removes, so an engine that HAS <dialog> reads back
// exactly what the UA already applied. A blanket rule would outrank that UA one
// and hide the modal while it is open, so the shape is pinned and not just the
// property.
const hidesClosedDialog = (css) =>
  /dialog:not\(\[open\]\)\s*\{[^}]*display:\s*none/.test(stripComments(css).replace(/\s+/g, " "));

test("source guard: a closed dialog is hidden even where <dialog> is unknown", () => {
  // Guard on the guard: the conditional form passes, the blanket form and the
  // class selector do not.
  assert.equal(hidesClosedDialog("dialog:not([open]) { display: none; }"), true);
  assert.equal(hidesClosedDialog("dialog { display: none; }"), false);
  assert.equal(hidesClosedDialog(".dialog { border: none; }"), false);

  assert.equal(
    hidesClosedDialog(read("../css/styles.css")),
    true,
    "the remove question and both its buttons are drawn permanently down the page on every pre-2022 Safari and Firefox",
  );
});

// --- The card with a charger price but no gas price -------------------------
//
// These rules used to be scanned here because render() built the card inline
// and nothing could import it. They now live in cardFor(), which returns the
// card as a value, so test/cardUi.test.mjs runs them instead of reading them:
// the priced case and its gate, both halves of its detail line, the verdict
// colour, the nudge, and the bare fallback. Scanning render() for them now
// only pins where the code sits, which is the thing that just moved.
//
// The same goes for the two detail lines sharing one inclusion note. cardFor
// takes a single inclNote and interpolates it in both places, so they cannot
// word it differently without a caller passing two, and both interpolations
// are asserted on in cardUi.test.mjs.

// --- One clock read per render ----------------------------------------------

// Every nowMinutes() call inside render(). Two of them can land either side of
// a minute boundary, pricing the charge from 8:59 PM while the time-of-day note
// reasons about 9:00 PM. cardFor's `now` argument is covered by import in
// cardUi.test.mjs; what is left over, and only expressible as a scan, is that
// render hands the SAME instant to the rate schedule and to the card.
// Not testable by import: render() is in main.js, which touches the DOM at load.
const clockReadsInRender = (src) => bodyOf(src, "render").match(/nowMinutes\(\)/g) ?? [];

test("source guard: render() reads the clock once", () => {
  // Guard on the guard: the hoisted shape and the two-read shape have to be
  // told apart, or this passes the one case it exists to catch.
  const wrap = (lines) => `function render() {\n${lines}\n}\n`;
  assert.equal(clockReadsInRender(wrap("  const nowMin = nowMinutes();\n  use(nowMin, nowMin);")).length, 1);
  assert.equal(clockReadsInRender(wrap("  const nowMin = nowMinutes();\n  use(nowMin, nowMinutes());")).length, 2);

  assert.equal(
    clockReadsInRender(read("../js/main.js")).length,
    1,
    "render() reads the wall clock more than once, so one render can price the charge against one minute while the time-of-day note talks about the next",
  );
});

// --- New charger ------------------------------------------------------------
//
// storage.test.mjs runs the rule for what it clears. What is left is in
// main.js, so it can only be read: the clear and the undo keep to the charger,
// the undo hands back the row nodes the clear took, and both are counted.

// main.js's top-level functions, each with the ones its body names. Named
// rather than called, so a function handed over as a callback
// (requestAnimationFrame(boot)) is an edge too. Only declarations are nodes,
// which is how main.js writes its functions.
function callGraph(src) {
  const s = stripComments(src);
  const names = [...s.matchAll(/^(?:async\s+)?function\s+(\w+)\s*\(/gm)].map((m) => m[1]);
  const named = names.map((n) => [n, new RegExp(`\\b${n}\\b`)]);
  return new Map(names.map((name) => {
    const body = bodyOf(s, name);
    return [name, named.filter(([n, re]) => n !== name && re.test(body)).map(([n]) => n)];
  }));
}

function reaches(src, from, to) {
  const graph = callGraph(src);
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    for (const next of graph.get(queue.pop()) ?? []) {
      if (next === to) return true;
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return false;
}

test("source guard: New charger's clear and its undo never reach boot()", () => {
  // Guard on the guard: a direct call, a call one helper down and boot handed
  // over as a callback are all caught. boot reaching the undo's helpers is not
  // the undo reaching boot, and a comment is not a call.
  const undo = (lines) => `function undoNewCharger() {\n${lines}\n}\n`;
  const rest = "function render() {\n  paint();\n}\nfunction boot() {\n  render();\n}\n";
  assert.equal(reaches(undo("  boot();") + rest, "undoNewCharger", "boot"), true);
  assert.equal(reaches(undo("  repaint();") + "function repaint() {\n  boot();\n}\n" + rest, "undoNewCharger", "boot"), true);
  assert.equal(reaches(undo("  requestAnimationFrame(boot);") + rest, "undoNewCharger", "boot"), true);
  assert.equal(reaches(undo("  // not boot(), which redraws the car tile\n  render();") + rest, "undoNewCharger", "boot"), false);

  const src = read("../js/main.js");
  for (const from of ["newCharger", "undoNewCharger"]) {
    assert.equal(
      reaches(src, from, "boot"),
      false,
      `${from} reaches boot(), so clearing or restoring the charger also rewrites the car tile and every field from prefs, not just the charger's`,
    );
  }
});

// The clear takes the rows as nodes and the undo puts those same nodes back.
// A clone, or markup written back, is a new row without the listener its
// min/hr picker wired to its button: it looks right and does nothing.
const ROW_CLONES = /\b(?:cloneNode|importNode)\b/;
const ROW_MARKUP = /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/;

function handsBackSameRows(src) {
  const clear = bodyOf(src, "clearChargerInputs");
  const undo = bodyOf(src, "undoNewCharger");
  if (ROW_CLONES.test(clear) || ROW_CLONES.test(undo) || ROW_MARKUP.test(undo)) return false;
  return /\[\s*\.\.\.\s*\$\(\s*\w+\s*\)\.children\s*\]/.test(clear) &&
    /\.(?:replaceChildren|append)\(\s*\.\.\.\s*[\w$.]+\.rows\b/.test(undo);
}

test("source guard: New charger's undo re-attaches the rows its clear took", () => {
  // Guard on the guard: the shipped shape passes either way it can put nodes
  // back, and each way of getting a copy instead fails.
  const pair = (clear, undo) => `function clearChargerInputs() {\n${clear}\n}\nfunction undoNewCharger() {\n${undo}\n}\n`;
  const take = "  const rows = IDS.map((id) => [...$(id).children]);";
  const giveBack = "  IDS.forEach((id, i) => $(id).replaceChildren(...taken.rows[i]));";
  assert.equal(handsBackSameRows(pair(take, giveBack)), true);
  assert.equal(handsBackSameRows(pair(take, "  IDS.forEach((id, i) => $(id).append(...taken.rows[i]));")), true);
  const bad = {
    "clones taken at the clear": ["  const rows = IDS.map((id) => [...$(id).children].map((r) => r.cloneNode(true)));", giveBack],
    "clones put back at the undo": [take, "  IDS.forEach((id, i) => $(id).replaceChildren(...taken.rows[i].map((r) => r.cloneNode(true))));"],
    "markup taken and written back": ["  const rows = IDS.map((id) => $(id).innerHTML);", "  IDS.forEach((id, i) => { $(id).innerHTML = taken.rows[i]; });"],
    "the nodes taken, their markup written back": [take, '  IDS.forEach((id, i) => { $(id).innerHTML = taken.rows[i].map((r) => r.outerHTML).join(""); });'],
    "rows rebuilt by their builders": [take, "  for (const r of taken.tou) addTouRow(cur, r.time, r.rate);"],
  };
  for (const [what, [clear, undo]] of Object.entries(bad)) {
    assert.equal(handsBackSameRows(pair(clear, undo)), false, `${what}, and the guard passed it`);
  }

  assert.equal(
    handsBackSameRows(read("../js/main.js")),
    true,
    "New charger's undo no longer puts back the row nodes its clear took, so a restored row's min/hr picker can come back dead",
  );
});

// Each event from the act it names. A literal anywhere in the file would pass
// a "charger-cleared" sent from the undo, which counts every undo as a clear.
const sentBy = (src, name) => trackArgs(bodyOf(src, name));

test("source guard: New charger's clear and its undo are still counted", () => {
  // Guard on the guard: the scan sees the call in the function it names and
  // not in the one after it.
  const two = 'function newCharger() {\n  trackWhenReady("charger-cleared");\n}\nfunction undoNewCharger() {\n  render();\n}\n';
  assert.deepEqual(sentBy(two, "newCharger"), ['"charger-cleared"']);
  assert.deepEqual(sentBy(two, "undoNewCharger"), []);

  const src = read("../js/main.js");
  for (const [name, event] of [["newCharger", "charger-cleared"], ["undoNewCharger", "charger-clear-undone"]]) {
    assert.ok(
      sentBy(src, name).includes(`"${event}"`),
      `${name} no longer sends ${event}, so its series stops in GoatCounter`,
    );
  }
});

// The footer Reset clears the charger with New charger's clear and none of its
// own, so a charger input added to clearChargerInputs is reset too. Watching
// for the old inline clear coming back. The call is a statement of its own
// (two spaces in, as every body here is), ahead of the boot() that paints it,
// and so is the drop of an undo still on offer, or a stale Undo outlives Reset.
const CHARGER_STATE = /\b(?:rateMode|chargeCapMin|capTouched|CHARGER_ROW_IDS|touRows|durRows|timeFeeRows|taxRows)\b/;

function resetUsesChargerClear(src) {
  const body = bodyOf(src, "resetEverything");
  if (CHARGER_STATE.test(body)) return false;
  const clear = body.search(/^  clearChargerInputs\(\);$/m);
  const drop = body.search(/^  dropChargerUndo\(\);$/m);
  const boot = body.search(/^  boot\(\);$/m);
  return clear !== -1 && drop !== -1 && boot !== -1 && clear < boot && drop < boot;
}

test("source guard: the footer Reset clears the charger with New charger's clear", () => {
  // Guard on the guard: the shipped shape passes, and each way back to a
  // second clear, or to a clear that does not always run in time, fails, and
  // so does an undo dropped late or never.
  const reset = (lines) => `function resetEverything() {\n  prefs = resetPrefs();\n${lines}\n}\n`;
  const tail = "  dropChargerUndo();\n  boot();";
  assert.equal(resetUsesChargerClear(reset(`  clearChargerInputs();\n${tail}`)), true);
  const bad = {
    "the old inline clear": `  rateMode = "flat";\n  chargeCapMin = null;\n  capTouched = false;\n  $("touRows").innerHTML = "";\n${tail}`,
    "a row cleared beside the shared clear": `  clearChargerInputs();\n  $("taxRows").innerHTML = "";\n${tail}`,
    "the clear after boot(), which paints nothing": `${tail}\n  clearChargerInputs();`,
    "the clear only sometimes": `  if (hadCharger) clearChargerInputs();\n${tail}`,
    "no clear at all": tail,
    "the undo dropped after boot()": "  clearChargerInputs();\n  boot();\n  dropChargerUndo();",
    "the undo never dropped": "  clearChargerInputs();\n  boot();",
  };
  for (const [what, lines] of Object.entries(bad)) {
    assert.equal(resetUsesChargerClear(reset(lines)), false, `${what}, and the guard passed it`);
  }

  assert.equal(
    resetUsesChargerClear(read("../js/main.js")),
    true,
    "the footer Reset no longer runs clearChargerInputs() and dropChargerUndo() ahead of boot(), so a charger input added to New charger's clear, or New charger's Undo, can outlive a Reset",
  );
});

// --- New charger: what a token-keeping mutation got past --------------------
//
// Each promise below broke under one mutation that kept every token, with the
// suite green. So each guard reads whole statements, two spaces in: a condition
// wrapped round one, or its right-hand side rewritten, fails like a deletion.

// The link shows while the charger holds something, and that something ends
// the undo. Inverted, the clear's own render() drops the undo it just took, so
// Undo is drawn and does nothing.
function offersNewChargerRightWayRound(src) {
  const body = bodyOf(src, "offerNewCharger");
  return /^  const hasInput = hasChargerInput\(/m.test(body) &&
    /^  \$\("newChargerBtn"\)\.hidden = !hasInput;$/m.test(body) &&
    /^  if \(hasInput\) dropChargerUndo\(\);$/m.test(body) &&
    (body.match(/\bdropChargerUndo\(/g) ?? []).length === 1;
}

test("source guard: New charger's link and undo follow the charger the right way round", () => {
  // Guard on the guard: the shipped shape passes, and each half inverted,
  // loosened or doubled fails.
  const offer = (lines) => `function offerNewCharger() {\n${lines.join("\n")}\n}\n`;
  const has = "  const hasInput = hasChargerInput(prefs, { rows: chargerRowValues(), capTouched });";
  const link = '  $("newChargerBtn").hidden = !hasInput;';
  const drop = "  if (hasInput) dropChargerUndo();";
  assert.equal(offersNewChargerRightWayRound(offer([has, link, drop])), true);
  const bad = {
    "the undo dropped on an empty charger": [has, link, "  if (!hasInput) dropChargerUndo();"],
    "the undo dropped on every render": [has, link, "  dropChargerUndo();"],
    "a drop on every render beside the gated one": [has, link, drop, "  dropChargerUndo();"],
    "the link shown on an empty charger": [has, '  $("newChargerBtn").hidden = hasInput;', drop],
    "both halves read off an inverted test": [has.replace("= hasChargerInput", "= !hasChargerInput"), link, drop],
  };
  for (const [what, lines] of Object.entries(bad)) {
    assert.equal(offersNewChargerRightWayRound(offer(lines)), false, `${what}, and the guard passed it`);
  }

  assert.equal(
    offersNewChargerRightWayRound(read("../js/main.js")),
    true,
    "offerNewCharger no longer hides the link on !hasInput and drops the undo on hasInput, so the clear's own render() kills its Undo, or the link sits on a blank form",
  );
});

// A row counts by what is typed in it, not by being there: Time of day and By
// duration open on two blank rows, and counted as nodes those alone offered New
// charger (Baadal, 2026-10-05). Run, not scanned: chargerRowValues() and
// offerNewCharger() are lifted out of main.js and run with storage.js's rule
// and ui.js's parseNum against stand-in rows, a leading control and a value
// field each, classed as editorRows.js builds them.
const field = (classes, value) => ({ classes: classes.split(" "), value });
const standInRow = (...fields) => ({
  querySelector(sel) {
    const wanted = sel.split(",").map((s) => s.trim());
    return fields.find((f) => f.classes.some((c) => wanted.includes(`.${c}`))) ?? null;
  },
});
const ROW = {
  tou: (time, rate = "") => standInRow(field("tou-time", time), field("tou-rate", rate)),
  dur: (after, rate = "") => standInRow(field("dur-min", after), field("dur-rate", rate)),
  fee: (after, perHour = "") => standInRow(field("dur-min tf-start", after), field("tf-rate", perHour)),
  tax: (name, pct = "") => standInRow(field("tax-label", name), field("tax-pct", pct)),
};

// Each case: the rows on the page, what else is entered, and whether the pill
// shows and a pending undo goes.
const OFFERS = [
  ["Time of day's two starter rows", { touRows: [ROW.tou("00:00"), ROW.tou("16:00")] }, {}, false],
  ["By duration's two starter rows", { durRows: [ROW.dur("0"), ROW.dur("60")] }, {}, false],
  ["starts moved on rows with no price", { touRows: [ROW.tou("05:30")], durRows: [ROW.dur("90")], timeFeeRows: [ROW.fee("2")] }, {}, false],
  ["a tax row with a name and no percentage", { taxRows: [ROW.tax("City tax")] }, {}, false],
  ["a price in a starter row", { touRows: [ROW.tou("00:00", "0.25"), ROW.tou("16:00")] }, {}, true],
  ["a 0 typed as a time fee", { timeFeeRows: [ROW.fee("0", "0")] }, {}, true],
  ["a 0 typed as a tax percentage", { taxRows: [ROW.tax("", "0")] }, {}, true],
  ["a dragged Charge for over blank rows", { durRows: [ROW.dur("0"), ROW.dur("60")] }, { capTouched: true }, true],
  ["a flat rate typed before Time of day", { touRows: [ROW.tou("00:00"), ROW.tou("16:00")] }, { prefs: { yourRate: 0.3 } }, true],
];

function offerOn(src, rows, { prefs = {}, capTouched = false }, startShown) {
  const btn = { hidden: !startShown };
  const $ = (id) => (id === "newChargerBtn" ? btn : { children: rows[id] ?? [] });
  let drops = 0;
  const lift = new Function(
    "$", "CHARGER_ROW_IDS", "parseNum", "hasChargerInput", "prefs", "capTouched", "dropChargerUndo",
    `${bodyOf(src, "chargerRowValues")}\n}\n${bodyOf(src, "offerNewCharger")}\n}\nreturn offerNewCharger;`,
  );
  const editors = ["touRows", "durRows", "timeFeeRows", "taxRows"];
  lift($, editors, parseNum, hasChargerInput, { ...defaultPrefs(), ...prefs }, capTouched, () => { drops += 1; })();
  return { shown: !btn.hidden, dropsUndo: drops > 0 };
}

// The cases where the pill, or the undo, does not follow what was typed.
function wrongOffers(src) {
  return OFFERS.filter(([, rows, rest, want]) => {
    try {
      const got = offerOn(src, rows, rest, !want);
      return got.shown !== want || got.dropsUndo !== want;
    } catch {
      return true;
    }
  }).map(([what]) => what);
}

test("source guard: New charger counts a row by what is typed in it, not by its being there", () => {
  // Guard on the guard: the shipped pair passes, and each way back to counting
  // rows, or to reading the wrong field, gets some case wrong.
  const SEL = ".tou-rate, .dur-rate, .tf-rate, .tax-pct";
  const values = (sel = SEL, tail = "") =>
    `function chargerRowValues() {\n  return CHARGER_ROW_IDS.flatMap((id) => [...$(id).children])\n    .map((row) => parseNum(row.querySelector("${sel}").value))${tail};\n}\n`;
  const offer = (args) =>
    `function offerNewCharger() {\n  const hasInput = hasChargerInput(prefs, { ${args} });\n  $("newChargerBtn").hidden = !hasInput;\n  if (hasInput) dropChargerUndo();\n}\n`;
  const shipped = "rows: chargerRowValues(), capTouched";
  assert.deepEqual(wrongOffers(values() + offer(shipped)), []);
  const bad = {
    "the rows counted as nodes, as before": values() + offer("rows: CHARGER_ROW_IDS.reduce((n, id) => n + $(id).children.length, 0), capTouched"),
    "every row read as a typed 0": values() + offer("rows: chargerRowValues().map(() => 0), capTouched"),
    "a blank read as 0": values(SEL, ".map((v) => v || 0)") + offer(shipped),
    "a row's start read for its price": values(".tou-time, .dur-min, .tax-label") + offer(shipped),
    "a typed 0 dropped, as the pricing readers drop it": values(SEL, ".filter((v) => v > 0)") + offer(shipped),
    "the dragged Charge for left out": values() + offer("rows: chargerRowValues()"),
  };
  for (const [what, src] of Object.entries(bad)) {
    assert.notDeepEqual(wrongOffers(src), [], `${what}, and the guard passed it`);
  }

  assert.deepEqual(
    wrongOffers(read("../js/main.js")),
    [],
    "offerNewCharger no longer judges each row by the price, rate or percentage typed in it, so a bare switch to Time of day or By duration offers New charger again and drops a pending Undo, or a typed price does not offer it",
  );
});

// A clear leaves the charger that storage.test.mjs's NOTHING_ELSE takes a fresh
// one to be. A kept capTouched is charger input: the link stays up and the
// clear's own render() drops its Undo.
const CLEARED_CHARGER = {
  "every row container emptied": /^  for \(const (\w+) of CHARGER_ROW_IDS\) \$\(\1\)\.replaceChildren\(\);$/m,
  "the prefs half cleared": /^  prefs = clearCharger\(prefs\);$/m,
  "flat mode": /^  rateMode = "flat";$/m,
  "no cap": /^  chargeCapMin = null;$/m,
  "no dragged Charge for": /^  capTouched = false;$/m,
};

const unclearedByNewCharger = (src) => {
  const body = bodyOf(src, "clearChargerInputs");
  return Object.keys(CLEARED_CHARGER).filter((what) => !CLEARED_CHARGER[what].test(body));
};

test("source guard: New charger's clear leaves the charger a fresh one is", () => {
  // Guard on the guard: the shipped body passes, each statement missing fails,
  // and so does each rewrite that keeps the tokens but not the value.
  const shipped = {
    "every row container emptied": "  for (const id of CHARGER_ROW_IDS) $(id).replaceChildren();",
    "the prefs half cleared": "  prefs = clearCharger(prefs);",
    "flat mode": '  rateMode = "flat";',
    "no cap": "  chargeCapMin = null;",
    "no dragged Charge for": "  capTouched = false;",
  };
  const clear = (lines) => `function clearChargerInputs() {\n${Object.values(lines).join("\n")}\n  return taken;\n}\n`;
  assert.deepEqual(unclearedByNewCharger(clear(shipped)), []);
  for (const what of Object.keys(shipped)) {
    const { [what]: gone, ...rest } = shipped;
    assert.deepEqual(unclearedByNewCharger(clear(rest)), [what], `${gone.trim()} missing, and the guard passed it`);
  }
  const rewrites = [
    ["no dragged Charge for", "  capTouched = capTouched || false;"],
    ["no dragged Charge for", "  capTouched = false || capTouched;"],
    ["no cap", "  if (capTouched) chargeCapMin = null;"],
    ["every row container emptied", "  for (const id of CHARGER_ROW_IDS.slice(1)) $(id).replaceChildren();"],
    ["every row container emptied", '  for (const id of CHARGER_ROW_IDS) $("touRows").replaceChildren();'],
  ];
  for (const [what, line] of rewrites) {
    assert.deepEqual(unclearedByNewCharger(clear({ ...shipped, [what]: line })), [what], `${line.trim()} passed as ${what}`);
  }

  assert.deepEqual(
    unclearedByNewCharger(read("../js/main.js")),
    [],
    "clearChargerInputs no longer leaves the charger storage.test.mjs's NOTHING_ELSE takes a fresh one to be, so a cleared charger still holds input: the link stays up and the clear's own render() drops its Undo",
  );
});

// The rows are every editor's rows on the page, read off index.html, and the
// list is a bare literal so nothing hung off it can drop one. A dropped taxRows
// keeps marking up the new charger's cost, uncounted, so nothing offers to clear it.
function chargerRowIdsIn(src) {
  const decl = stripComments(src).match(/^const CHARGER_ROW_IDS = \[([^\]]*)\];$/m);
  return decl ? [...decl[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]).sort() : null;
}

const rowContainersIn = (html) =>
  [...html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/\sid="(\w+Rows)"/g)].map((m) => m[1]).sort();

test("source guard: New charger clears the rows of every editor on the page", () => {
  // Guard on the guard: the list reads back only as a bare literal, a
  // commented-out container is not on the page, and one missing and one extra
  // are each told apart from the same set.
  const page = '<div id="touRows"></div>\n<!-- <div id="oldRows"></div> -->\n<div id="taxRows"></div>\n<p id="taxNote"></p>';
  const both = ["taxRows", "touRows"];
  assert.deepEqual(rowContainersIn(page), both);
  assert.deepEqual(chargerRowIdsIn('const CHARGER_ROW_IDS = ["touRows", "taxRows"];\n'), both);
  assert.equal(chargerRowIdsIn('const CHARGER_ROW_IDS = ["touRows", "taxRows"].filter((id) => id !== "taxRows");\n'), null);
  assert.notDeepEqual(chargerRowIdsIn('const CHARGER_ROW_IDS = ["touRows"];\n'), both);
  assert.notDeepEqual(chargerRowIdsIn('const CHARGER_ROW_IDS = ["touRows", "taxRows", "oldRows"];\n'), both);

  const containers = rowContainersIn(read("../index.html"));
  assert.ok(containers.length >= 4, `only ${containers.length} row containers found in index.html: the page scan broke`);
  assert.deepEqual(
    chargerRowIdsIn(read("../js/main.js")),
    containers,
    "CHARGER_ROW_IDS is not a bare literal naming exactly the editors' row containers in index.html, so New charger can leave an old charger's rows pricing the new one, with nothing offering to clear them",
  );
});

// Skipped, or gated on the mode the clear just set, applyRateMode() leaves
// Energy rate hidden under a flat radio after a clear from time of day or by
// duration, and that is the field the clear focuses for the new price.
const NEW_CHARGER_STEPS = [
  /^  chargerUndo = clearChargerInputs\(\);$/m,
  /^  applyRateMode\(\);$/m,
  /^  paintChargerFields\(\);$/m,
  /^  render\(\);$/m,
];

function newChargerRunsInOrder(src) {
  const body = bodyOf(src, "newCharger");
  const at = NEW_CHARGER_STEPS.map((re) => body.search(re));
  return at.every((i, n) => i !== -1 && (n === 0 || at[n - 1] < i));
}

test("source guard: New charger clears, then applies the mode, then paints", () => {
  // Guard on the guard: the shipped order passes; each step missing, the mode
  // applied only off flat, render() ahead of applyRateMode() and a clear whose
  // snapshot is thrown away each fail.
  const steps = ["  chargerUndo = clearChargerInputs();", "  applyRateMode();", "  paintChargerFields();", "  render();"];
  const fresh = (lines) => `function newCharger() {\n${lines.join("\n")}\n  $("yourRate").focus();\n}\n`;
  assert.equal(newChargerRunsInOrder(fresh(steps)), true);
  for (const step of steps) {
    assert.equal(newChargerRunsInOrder(fresh(steps.filter((s) => s !== step))), false, `${step.trim()} missing, and the guard passed it`);
  }
  const [clear, mode, fields, card] = steps;
  const bad = {
    "the mode applied only off flat": [clear, '  if (rateMode !== "flat") applyRateMode();', fields, card],
    "applyRateMode() after render()": [clear, fields, card, mode],
    "the snapshot thrown away": ["  clearChargerInputs();", mode, fields, card],
  };
  for (const [what, lines] of Object.entries(bad)) {
    assert.equal(newChargerRunsInOrder(fresh(lines)), false, `${what}, and the guard passed it`);
  }

  assert.equal(
    newChargerRunsInOrder(read("../js/main.js")),
    true,
    "newCharger no longer runs clearChargerInputs(), applyRateMode(), paintChargerFields() and render() as statements in that order, so a charger cleared from time of day or by duration can leave Energy rate hidden under a flat radio",
  );
});

// Outside Flat the mode's rows take Energy rate's place (Baadal's layout A),
// so the field goes rather than sitting disabled beside them, and it is hidden
// rather than cleared, so a flat rate typed first is back on Flat. Run, not
// scanned: applyRateMode() is lifted out of main.js against stand-in nodes,
// each starting in the state the mode must change.
function runApplyRateMode(src, mode) {
  const node = (hidden) => ({ hidden, disabled: false, children: { length: 2 } });
  const field = node(mode === "flat");
  const rate = { ...node(false), closest: (sel) => (sel === ".field" ? field : null) };
  const stale = { "aria-labelledby": `rateModeName-${mode === "flat" ? "tod" : "flat"}` };
  const panel = { attrs: stale, setAttribute(name, value) { this.attrs[name] = String(value); } };
  const nodes = { touEditor: node(true), durEditor: node(true), touRows: node(false), durRows: node(false), yourRate: rate, ratePanel: panel };
  const lift = new Function("$", "rateMode", "prefs", "addTouRow", "addDurRow", `${bodyOf(src, "applyRateMode")}\n}\nreturn applyRateMode;`);
  lift((id) => nodes[id], mode, { currency: "USD" }, () => {}, () => {})();
  return { field, rate, panel };
}

function rateFieldAfter(src, mode) {
  const { field, rate } = runApplyRateMode(src, mode);
  return { hidden: field.hidden, disabled: rate.disabled };
}

const RATE_MODES = { flat: false, tod: true, dur: true };

function hidesRateFieldOffFlat(src) {
  return Object.entries(RATE_MODES).every(([mode, hidden]) => {
    const got = rateFieldAfter(src, mode);
    return got.hidden === hidden && got.disabled === false;
  });
}

test("source guard: applyRateMode() hides Energy rate outside Flat, never disables it", () => {
  // Guard on the guard: the shipped line passes; the comparison flipped (same
  // tokens), the field disabled instead and the line dropped each fail.
  const fresh = (line) => `function applyRateMode() {\n  $("touEditor").hidden = rateMode !== "tod";\n  $("durEditor").hidden = rateMode !== "dur";\n${line}\n}\n`;
  const hides = '  $("yourRate").closest(".field").hidden = rateMode !== "flat";';
  assert.equal(hidesRateFieldOffFlat(fresh(hides)), true);
  assert.equal(hidesRateFieldOffFlat(fresh(hides.replace("!==", "==="))), false, "the comparison flipped, and the guard passed it");
  assert.equal(hidesRateFieldOffFlat(fresh('  $("yourRate").disabled = rateMode !== "flat";')), false, "the field disabled instead of hidden, and the guard passed it");
  assert.equal(hidesRateFieldOffFlat(fresh("")), false, "the field left alone, and the guard passed it");

  const src = read("../js/main.js");
  for (const [mode, hidden] of Object.entries(RATE_MODES)) {
    assert.deepEqual(
      rateFieldAfter(src, mode),
      { hidden, disabled: false },
      `on ${mode}, Energy rate is not ${hidden ? "hidden" : "shown"} and enabled, so the layout shows the wrong price field or a greyed one beside the rows`,
    );
  }
});

// The rate panel is what the checked mode prices with: Energy rate and both
// editors live in it, the radios control it, and it is a group named after
// the checked mode, so a screen reader hears "Time of day, group" over the
// rows it is about to fill. index.html holds the panel and each mode's name;
// applyRateMode(), run as above, has to point the panel at the checked one.
function ratePanelProblems(html, src) {
  const page = html.replace(/<!--[\s\S]*?-->/g, "");
  const open = page.search(/<div\b[^>]*\sid="ratePanel"/);
  if (open === -1) return ["no #ratePanel"];
  const tags = /<(\/?)div\b[^>]*>/g;
  tags.lastIndex = open;
  let depth = 0;
  let panel = "";
  for (let m; !panel && (m = tags.exec(page));) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) panel = page.slice(open, tags.lastIndex);
  }
  const problems = [];
  if (!/^<div\b[^>]*\srole="group"/.test(panel)) problems.push("the panel is not a group");
  for (const id of ["yourRate", "touEditor", "durEditor"]) {
    if (!panel.includes(` id="${id}"`)) problems.push(`#${id} is outside the panel`);
  }
  const names = {};
  for (const [, label] of page.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
    const radio = label.match(/<input\b[^>]*\sname="rateMode"[^>]*>/)?.[0];
    if (!radio) continue;
    const mode = radio.match(/\svalue="(\w+)"/)?.[1];
    if (!radio.includes(' aria-controls="ratePanel"')) problems.push(`the ${mode} radio does not control the panel`);
    names[mode] = label.match(/<span\b[^>]*\sid="([^"]+)"/)?.[1];
  }
  for (const mode of Object.keys(RATE_MODES)) {
    const named = runApplyRateMode(src, mode).panel.attrs["aria-labelledby"];
    if (!names[mode] || named !== names[mode]) problems.push(`on ${mode} the panel is labelled by ${named}, not by the ${mode} label's ${names[mode]}`);
  }
  return problems;
}

test("source guard: the rate panel holds the three editors and is named after the checked mode", () => {
  // Guard on the guard: the shipped shape passes; two mode names swapped, the
  // By duration editor closed off outside the panel, the name set only on
  // Flat (all three same tokens), the line dropped and no panel each fail.
  const radio = (mode, text) => `<label><input type="radio" name="rateMode" value="${mode}" aria-controls="ratePanel" /><span id="rateModeName-${mode}">${text}</span></label>`;
  const radios = `<div id="rateMode" role="radiogroup">\n${radio("flat", "Flat")}\n${radio("tod", "Time of day")}\n${radio("dur", "By duration")}\n</div>`;
  const editors = '<div class="field"><input id="yourRate" /></div>\n<div id="touEditor" hidden><div id="touRows"></div></div>\n<div id="durEditor" hidden>\n<div id="durRows"></div>\n</div>\n';
  const page = (body = editors) => `${radios}\n<div id="ratePanel" role="group" aria-labelledby="rateModeName-flat">\n${body}</div>\n`;
  const names = '  $("ratePanel").setAttribute("aria-labelledby", `rateModeName-${rateMode}`);';
  const fn = (line) => `function applyRateMode() {\n  $("touEditor").hidden = rateMode !== "tod";\n${line}\n}\n`;
  assert.deepEqual(ratePanelProblems(page(), fn(names)), []);
  const bad = {
    "two mode names swapped": [page().replace('id="rateModeName-tod">Time', 'id="rateModeName-x">Time').replace('id="rateModeName-dur">', 'id="rateModeName-tod">').replace('id="rateModeName-x">', 'id="rateModeName-dur">'), fn(names)],
    "the By duration editor outside the panel": [page(editors.replace('<div id="durEditor" hidden>\n<div id="durRows"></div>\n</div>\n', "")) + '<div id="durEditor" hidden>\n<div id="durRows"></div>\n</div>\n', fn(names)],
    "the name set only on Flat": [page(), fn(`  if (rateMode === "flat") ${names.trim()}`)],
    "the line dropped": [page(), fn("")],
    "no panel": [page().replace(' id="ratePanel"', ""), fn(names)],
  };
  for (const [what, [html, src]] of Object.entries(bad)) {
    assert.notDeepEqual(ratePanelProblems(html, src), [], `${what}, and the guard passed it`);
  }

  assert.deepEqual(
    ratePanelProblems(read("../index.html"), read("../js/main.js")),
    [],
    "the rate panel no longer holds Energy rate and both editors, or is not named after the checked mode, so a screen reader is not told which pricing mode the rows it is filling belong to",
  );
});

// With no battery size there is no kWh to count, so the card judges the rate
// the charge starts on, and outside Flat that is the mode's, never m.yourRate:
// Energy rate is hidden there and can still hold the Flat price. The rule is
// effectivePerKwh()'s (cardUi.test.mjs); this holds render() to handing it
// its own rateOf. Run, not scanned: the statement is lifted out of render()
// at 5 PM on a Time of day rate of 0.45, with 0.30 left in Energy rate.
const EVENING = 17 * 60;

function unsizedChargeJudgedAt(src) {
  const line = bodyOf(src, "render").match(/^  const effective = effectivePerKwh\(\{[^{}]*\}\);$/m)?.[0];
  if (!line) return null;
  const lift = new Function("effectivePerKwh", "m", "hasRate", "kwh", "session", "rateOf", "startClockMin", "taxRate", `${line}\nreturn effective;`);
  const rateOf = (clock) => (clock >= EVENING ? 0.45 : 0.25);
  return lift(effectivePerKwh, { yourRate: 0.3 }, true, 0, { effectivePerKwh: NaN }, rateOf, EVENING, 0.1);
}

test("source guard: with no battery size, render() judges the mode's own rate, not the hidden Energy rate", () => {
  // Guard on the guard: the shipped call passes; the old inline rule and a
  // call whose rateOf reads m.yourRate (every token kept) each fail.
  const fresh = (lines) => `function render() {\n${lines}\n}\n`;
  const judges = "  const effective = effectivePerKwh({ hasRate, kwh, session, rateOf, startClockMin, taxRate });";
  assert.equal(unsizedChargeJudgedAt(fresh(judges)), 0.45 * 1.1);
  const bad = {
    "the old inline rule": "  let effective = NaN;\n  if (hasRate) {\n    effective = kwh > 0 ? session.effectivePerKwh : m.yourRate * (1 + taxRate);\n  }",
    "a rateOf that reads m.yourRate": judges.replace("rateOf,", "rateOf: () => m.yourRate,"),
  };
  for (const [what, lines] of Object.entries(bad)) {
    assert.notEqual(unsizedChargeJudgedAt(fresh(lines)), 0.45 * 1.1, `${what}, and the guard passed it`);
  }

  assert.equal(
    unsizedChargeJudgedAt(read("../js/main.js")),
    0.45 * 1.1,
    "render() no longer judges a charge with no battery size by effectivePerKwh() with its own rateOf, so Time of day and By duration can be judged on the Flat price hidden in Energy rate (0.30 instead of the 0.45 evening rate)",
  );
});

// Baadal asked whether a price filled in one option can interfere once he
// picks another. render() resolves ONE pricing model: the checked mode's
// reader alone runs, the rate comes from that mode alone, and Time of day or
// By duration with no priced row asks for its rates rather than falling back
// to the Flat price hidden in Energy rate. Run, not scanned: render() is
// lifted up to drawKw, with all three modes filled in and each reader counted.
// Only that part runs, so each reader has to be named there once and nowhere
// below it, where no run would count it.
const FILLED = { schedule: [{ start: 0, rate: 0.25 }, { start: 960, rate: 0.45 }], tiers: [{ start: 0, rate: 0.2 }, { start: 60, rate: 0.4 }] };
const RATE_SAMPLES = [[EVENING, 0], [9 * 60, 90]]; // [clock, elapsed]

const DRAW_KW = "\n  const drawKw = ";

function pricingModelIn(src, rateMode, priced) {
  const body = bodyOf(src, "render");
  const end = body.indexOf(DRAW_KW);
  if (end === -1) return { error: "render() has no `const drawKw = ` line, the anchor pricingModelIn runs it up to: follow drawKw if it was renamed" };
  const reads = { schedule: 0, tiers: 0 };
  try {
    const lift = new Function(
      "readInputs", "prefs", "nowMinutes", "breakevenKwhPrice", "$", "readTimeFee", "readTaxRate",
      "readSchedule", "readDurationTiers", "rateAtTime", "rateAtElapsed", "rateMode",
      `${body.slice(body.indexOf("{\n") + 2, end)}\nreturn { rateOf, hasRate, startClockMin };`,
    );
    const got = lift(
      () => ({ yourRate: 0.3 }), { currency: "USD" }, () => EVENING, () => NaN, () => ({}), () => [], () => 0,
      () => { reads.schedule += 1; return priced ? FILLED.schedule : []; },
      () => { reads.tiers += 1; return priced ? FILLED.tiers : []; },
      rateAtTime, rateAtElapsed, rateMode,
    );
    return { reads, hasRate: got.hasRate, startClockMin: got.startClockMin, rates: RATE_SAMPLES.map(([clock, elapsed]) => got.rateOf(clock, elapsed)) };
  } catch (e) {
    return { error: `${e}. pricingModelIn runs render() only up to the drawKw anchor, with only its stub list in scope: stub a new name in that list, or follow drawKw if it moved above the pricing block` };
  }
}

// Why the lift could not run, one line per run; empty when every run got through.
const liftFailures = (models) => Object.entries(models).filter(([, got]) => "error" in got).map(([run, got]) => `${run}: ${got.error}`);

// How often render() names each reader: [above drawKw, below it].
function readersNamedIn(src) {
  const body = bodyOf(src, "render");
  const end = body.indexOf(DRAW_KW);
  return Object.fromEntries(["readSchedule", "readDurationTiers"].map((name) => {
    const at = [...body.matchAll(new RegExp(String.raw`\b${name}\b`, "g"))].map((x) => x.index);
    return [name, [at.filter((i) => i < end).length, at.filter((i) => i > end).length]];
  }));
}

const pricingModels = (src) => ({
  flat: pricingModelIn(src, "flat", true),
  tod: pricingModelIn(src, "tod", true),
  dur: pricingModelIn(src, "dur", true),
  "tod, no priced row": pricingModelIn(src, "tod", false),
  "dur, no priced row": pricingModelIn(src, "dur", false),
  "readers named in render(), [above drawKw, below it]": readersNamedIn(src),
});

const ONE_PRICING_MODEL = {
  flat: { reads: { schedule: 0, tiers: 0 }, hasRate: true, startClockMin: 0, rates: [0.3, 0.3] },
  tod: { reads: { schedule: 1, tiers: 0 }, hasRate: true, startClockMin: EVENING, rates: [0.45, 0.25] },
  dur: { reads: { schedule: 0, tiers: 1 }, hasRate: true, startClockMin: 0, rates: [0.2, 0.4] },
  "tod, no priced row": { reads: { schedule: 1, tiers: 0 }, hasRate: false, startClockMin: 0, rates: [0, 0] },
  "dur, no priced row": { reads: { schedule: 0, tiers: 1 }, hasRate: false, startClockMin: 0, rates: [0, 0] },
  "readers named in render(), [above drawKw, below it]": { readSchedule: [1, 0], readDurationTiers: [1, 0] },
};

test("source guard: render() prices with the checked mode alone, and never falls back to Flat", () => {
  // Guard on the guard: the shipped block passes; Flat as the fallback, the
  // two readers swapped between branches, readSchedule() hoisted above the
  // if and By duration's reader named again below drawKw (every token kept
  // in the last three) each run and fail. A lift that cannot run says why,
  // and names neither mode.
  const fresh = (block, below = "") => `function render() {\n${block}\n  const drawKw = chargeDrawKw(m.powerKw, ceilingCar());\n${below}}\n`;
  const block = [
    "  const m = readInputs();",
    "  const nowMin = nowMinutes();",
    "  let rateOf = null, schedule = null, hasRate = false, startClockMin = 0, durTiers = null;",
    '  if (rateMode === "tod") {',
    "    schedule = readSchedule();",
    "    if (schedule.length) { rateOf = (clock) => rateAtTime(schedule, clock); hasRate = true; startClockMin = nowMin; }",
    '  } else if (rateMode === "dur") {',
    "    durTiers = readDurationTiers();",
    "    if (durTiers.length) { rateOf = (_clock, elapsed) => rateAtElapsed(durTiers, elapsed); hasRate = true; }",
    "  }",
    "  if (!rateOf) {",
    '    if (rateMode === "flat") hasRate = Number.isFinite(m.yourRate) && m.yourRate >= 0;',
    "    rateOf = () => (hasRate ? m.yourRate : 0);",
    "  }",
  ].join("\n");
  assert.deepEqual(pricingModels(fresh(block)), ONE_PRICING_MODEL);
  const bad = {
    "Flat as the fallback": fresh(block.replace('if (rateMode === "flat")', 'if (rateMode === "flat" || !hasRate)')),
    "the two readers swapped": fresh(block.replace(/readSchedule\(\)|readDurationTiers\(\)/g, (r) => (r === "readSchedule()" ? "readDurationTiers()" : "readSchedule()"))),
    "readSchedule() hoisted above the if": fresh(block.replace("    schedule = readSchedule();\n", "").replace('  if (rateMode === "tod") {', '  schedule = readSchedule();\n  if (rateMode === "tod") {')),
    "By duration's reader named again below drawKw": fresh(block, '  const view = cardFor({ schedule: rateMode === "tod" ? readDurationTiers() : schedule });\n'),
  };
  for (const [what, src] of Object.entries(bad)) {
    const models = pricingModels(src);
    assert.deepEqual(liftFailures(models), [], `${what} did not run`);
    assert.notDeepEqual(models, ONE_PRICING_MODEL, `${what}, and the guard passed it`);
  }
  const broken = {
    "an unstubbed name above drawKw": [fresh(`  const car = currentCar();\n${block}`), /^\w[^:]*: ReferenceError: currentCar is not defined\. .*stub list.*drawKw/],
    "drawKw moved up under readInputs()": [`function render() {\n  const m = readInputs();\n  const drawKw = chargeDrawKw(m.powerKw, ceilingCar());\n${block.replace("  const m = readInputs();\n", "")}\n}\n`, /^\w[^:]*: ReferenceError: rateOf is not defined\. .*stub list.*drawKw/],
    "no drawKw line": [fresh(block).replace("const drawKw", "const drawnKw"), /^\w[^:]*: render\(\) has no `const drawKw = ` line, the anchor/],
  };
  for (const [what, [src, why]] of Object.entries(broken)) {
    const failures = liftFailures(pricingModels(src));
    assert.equal(failures.length, 5, `${what}, and the lift ran anyway`);
    for (const failure of failures) assert.match(failure, why, `${what}, and the lift does not say so`);
  }

  const shipped = pricingModels(read("../js/main.js"));
  const failures = liftFailures(shipped);
  assert.deepEqual(failures, [], `render() could not be lifted and run up to drawKw, so nothing was checked (this is not a leak):\n${failures.join("\n")}`);
  assert.deepEqual(
    shipped,
    ONE_PRICING_MODEL,
    "render() no longer prices with the checked mode alone: another mode's editor is read or priced from (above drawKw, or named below it where no run counts it), or Time of day or By duration with no priced row falls back to the Flat price hidden in Energy rate, so filling one option changes another (Baadal's question)",
  );
});

// Without showEffective the card says "You pay" with m.yourRate (cardUi.js),
// and outside Flat that is the Flat price hidden in Energy rate. So Time of
// day and By duration always show the effective rate, and Flat shows it only
// when fees make it differ. Run, not scanned: the statement is lifted out of
// render() with rateMode and hasFees in scope. Per mode: [no fees, fees].
const SHOWS_EFFECTIVE = { flat: [false, true], tod: [true, true], dur: [true, true] };

function effectiveShownIn(src) {
  const line = bodyOf(src, "render").match(/^  const showEffective = [^\n]*;$/m)?.[0];
  if (!line) return { error: "render() has no one-line `const showEffective = ...;` for effectiveShownIn to lift" };
  try {
    const lift = new Function("rateMode", "hasFees", `${line}\nreturn showEffective;`);
    return Object.fromEntries(Object.keys(SHOWS_EFFECTIVE).map((mode) => [mode, [false, true].map((hasFees) => lift(mode, hasFees))]));
  } catch (e) {
    return { error: `${e}. effectiveShownIn runs the line with only rateMode and hasFees in scope: give it any new name` };
  }
}

test("source guard: outside Flat, render() shows the effective rate, never the Flat price hidden in Energy rate", () => {
  // Guard on the guard: the shipped rule passes; || turned into && and the
  // mode term dropped each run and fail, and a line that cannot run says why.
  const fresh = (line) => `function render() {\n${line}\n}\n`;
  const rule = '  const showEffective = rateMode !== "flat" || hasFees;';
  assert.deepEqual(effectiveShownIn(fresh(rule)), SHOWS_EFFECTIVE);
  for (const [what, line] of Object.entries({ "|| turned into &&": rule.replace("||", "&&"), "the mode term dropped": "  const showEffective = hasFees;" })) {
    const got = effectiveShownIn(fresh(line));
    assert.equal(got.error, undefined, `${what} did not run`);
    assert.notDeepEqual(got, SHOWS_EFFECTIVE, `${what}, and the guard passed it`);
  }
  assert.match(effectiveShownIn(fresh(rule.replace("hasFees", "hasFees || hasTax"))).error, /^ReferenceError: hasTax is not defined\. .*give it/);

  const shipped = effectiveShownIn(read("../js/main.js"));
  assert.equal(shipped.error, undefined, `render()'s showEffective rule could not be run, so nothing was checked (this is not a leak): ${shipped.error}`);
  assert.deepEqual(
    shipped,
    SHOWS_EFFECTIVE,
    "render() no longer shows the effective rate on every Time of day and By duration card: with no fees the card says \"You pay\" with the Flat price hidden in Energy rate, so filling one option changes another (Baadal's question)",
  );
});

// The declarations of the rule with exactly this selector, in source order,
// as [property, value] pairs. Undefined when there is no such rule.
function declarationsOf(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "").match(new RegExp(`(?:^|[;{}]\\s*)${esc}\\s*\\{([^}]*)\\}`))?.[1];
  return body?.split(";").map((d) => d.split(":")).filter((p) => p.length > 1).map(([p, ...v]) => [p.trim(), v.join(":").trim()]);
}

const lastOf = (decls, ...props) => decls?.filter(([p]) => props.includes(p)).at(-1)?.[1];

// The selected tab's top border as the cascade leaves it: the tab rule, then
// the checked one, each declaration overriding those before it.
function selectedCap(css) {
  const decls = [...(declarationsOf(css, "#rateMode span") ?? []), ...(declarationsOf(css, "#rateMode input:checked + span") ?? [])];
  const STYLE = /^(?:none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/;
  const px = (t) => (/^\d+(?:\.\d+)?px$|^0$/.test(t) ? parseFloat(t) : null);
  const cap = { width: NaN, style: "none", color: "currentcolor" };
  for (const [prop, value] of decls) {
    const parts = value.split(/\s+/);
    if (prop === "border" || prop === "border-top") {
      cap.width = parts.map(px).find((n) => n !== null) ?? NaN;
      cap.style = parts.find((t) => STYLE.test(t)) ?? "none";
      cap.color = parts.find((t) => px(t) === null && !STYLE.test(t)) ?? "currentcolor";
    } else if (prop === "border-width" || prop === "border-top-width") cap.width = px(parts[0]) ?? NaN;
    else if (prop === "border-style" || prop === "border-top-style") cap.style = parts[0];
    else if (prop === "border-color" || prop === "border-top-color") cap.color = parts[0];
  }
  return cap;
}

// The selected pricing mode is told apart by more than its green text: it is
// the tab cut from the rate panel's own surface, under a 3px cap in the
// accent, where the unselected tabs are bare text (WCAG 1.4.11, and not by
// color alone). The surface is barely off the card, so the cap carries it.
function capsSelectedTab(css) {
  const surface = lastOf(declarationsOf(css, "#rateMode input:checked + span"), "background", "background-color");
  const cap = selectedCap(css);
  return Boolean(surface) && !/^(?:none|transparent)$/.test(surface)
    && surface === lastOf(declarationsOf(css, "#ratePanel"), "background", "background-color")
    && cap.width >= 3 && !/^(?:none|hidden)$/.test(cap.style) && cap.color === "var(--accent)";
}

const TAB_RULE = "#rateMode span {\n  border: 1px solid transparent;\n  border-top-width: 3px;\n  border-bottom: 0;\n}";
const CHECKED_TAB = "background: var(--card-2);\n  border-color: var(--line);\n  border-top-color: var(--accent);";
const tabSheet = ({ tab = TAB_RULE, checked = CHECKED_TAB, panel = "var(--card-2)", extra = "" } = {}) =>
  `${tab}\n#rateMode input:checked + span {\n  ${checked}\n}\n#ratePanel {\n  background: ${panel};\n}\n${extra}`;

test("source guard: the selected pricing mode is the panel's tab, capped in the accent", () => {
  // Guard on the guard: the shipped tab passes; a 1px cap, the cap color set
  // before the edge color that then paints it grey, and the cap width set
  // before the shorthand that resets it (all three same tokens), a tab off
  // the panel's surface and the old ring rule each fail.
  assert.equal(capsSelectedTab(tabSheet()), true);
  const bad = {
    "a 1px cap": tabSheet({ tab: TAB_RULE.replace("top-width: 3px", "top-width: 1px") }),
    "the cap color set before the edge color": tabSheet({ checked: "background: var(--card-2);\n  border-top-color: var(--accent);\n  border-color: var(--line);" }),
    "the cap width set before the border shorthand": tabSheet({ tab: "#rateMode span {\n  border-top-width: 3px;\n  border: 1px solid transparent;\n  border-bottom: 0;\n}" }),
    "a tab off the panel's surface": tabSheet({ panel: "var(--card)" }),
    "the old ring rule": ".segmented input:checked + span {\n  background: var(--card);\n  color: var(--accent);\n  box-shadow: inset 0 0 0 2px var(--accent);\n}",
  };
  for (const [what, css] of Object.entries(bad)) {
    assert.equal(capsSelectedTab(css), false, `${what}, and the guard passed it`);
  }

  assert.equal(
    capsSelectedTab(read("../css/styles.css")),
    true,
    "the selected pricing tab lost its 3px accent cap or the rate panel's surface, so it no longer reads as the open tab of the panel it prices, and is marked by its green text alone, which color-blind users and WCAG 1.4.11 cannot rely on",
  );
});

// The pricing radios are opacity 0, so their own focus ring is never seen: the
// tab after a focused radio has to draw one, or Tab and the arrows move an
// invisible focus. Tab and the arrows always land on the checked tab, so the
// ring has to stand 2px clear of its cap: on it, same green, focus reads as
// selection. Inset, that is under the cap; outside the tab, off its edge.
function showsTabFocus(css) {
  const focus = declarationsOf(css, "#rateMode input:focus-visible + span");
  const ring = lastOf(focus, "outline")?.match(/^(\d+(?:\.\d+)?)px solid var\(--accent\)$/);
  const offset = parseFloat(lastOf(focus, "outline-offset") ?? "0");
  if (!ring || Number(ring[1]) < 2 || !Number.isFinite(offset)) return false;
  const clear = offset >= 0 ? offset : -offset - Number(ring[1]) - selectedCap(css).width;
  return clear >= 2;
}

test("source guard: keyboard focus shows on the pricing switch, clear of the cap", () => {
  // Guard on the guard: the inset ring passes, and so does one set 2px
  // outside the tab; a zero-width one (same tokens), one on :checked instead
  // of :focus-visible, one pulled onto the cap or against it (same tokens)
  // and no rule at all each fail.
  const focusRule = (sel, outline, offset) => tabSheet({ extra: `${sel} { outline: ${outline}; outline-offset: ${offset}; }` });
  const FOCUS = "#rateMode input:focus-visible + span";
  assert.equal(showsTabFocus(focusRule(FOCUS, "2px solid var(--accent)", "-7px")), true);
  assert.equal(showsTabFocus(focusRule(FOCUS, "2px solid var(--accent)", "2px")), true);
  const bad = {
    "a zero-width outline": focusRule(FOCUS, "0px solid var(--accent)", "-7px"),
    "an outline on selection, not focus": focusRule("#rateMode input:checked + span", "2px solid var(--accent)", "-7px"),
    "an outline drawn on the cap": focusRule(FOCUS, "2px solid var(--accent)", "-2px"),
    "an outline against the cap": focusRule(FOCUS, "2px solid var(--accent)", "-5px"),
    "no focus rule": tabSheet(),
  };
  for (const [what, css] of Object.entries(bad)) {
    assert.equal(showsTabFocus(css), false, `${what}, and the guard passed it`);
  }

  assert.equal(
    showsTabFocus(read("../css/styles.css")),
    true,
    "a keyboard user tabbing to the pricing switch or arrowing through it cannot see where focus is, or sees it merge into the selected tab's green cap",
  );
});

// --- The Charger tile is what New charger clears ----------------------------
//
// The pill sits on the tile's heading, so the tile is the promise. An input in
// it that the clear keeps survives a tap that claims to clear it; an input the
// clear resets elsewhere on the page is wiped by a button that never named it.

// The page's inputs by the name the clear knows them by: the id, a radio
// group's name, and each editor's row container, whose rows come and go.
function controlsIn(html) {
  const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? "(unnamed)";
  const inputs = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)]
    .map(([tag]) => (/\stype="radio"/.test(tag) ? attr(tag, "name") : attr(tag, "id")));
  const rows = [...html.matchAll(/\sid="(\w+Rows)"/g)].map((m) => m[1]);
  return [...new Set([...inputs, ...rows])].sort();
}

// The tile and the rest of the page, comments out. Null when there is no tile.
function splitAtChargerTile(html) {
  const page = html.replace(/<!--[\s\S]*?-->/g, "");
  const open = page.search(/<section\b[^>]*\sid="chargerTile"/);
  if (open === -1) return null;
  const tags = /<(\/?)section\b[^>]*>/g;
  tags.lastIndex = open;
  let depth = 0;
  for (let m; (m = tags.exec(page));) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { tile: page.slice(open, tags.lastIndex), rest: page.slice(0, open) + page.slice(tags.lastIndex) };
  }
  return null;
}

// What clearChargerInputs resets, by control: an input per CHARGER_KEYS key,
// the rows of every editor, and the face of the module state the guard on the
// clear pins (rateMode is the radio group, chargeCapMin the Charge for slider).
const clearedControls = (keys, rowIds) => [...keys, ...rowIds, "rateMode", "chargeForMin"].sort();

function chargerTileMismatch(html, cleared) {
  const parts = splitAtChargerTile(html);
  if (!parts) return ["no Charger tile"];
  const inTile = controlsIn(parts.tile);
  const outside = controlsIn(parts.rest);
  return [
    ...inTile.filter((c) => !cleared.includes(c)).map((c) => `${c} is in the tile and kept`),
    ...cleared.filter((c) => !inTile.includes(c)).map((c) => `${c} is cleared and not in the tile`),
    ...cleared.filter((c) => outside.includes(c)).map((c) => `${c} is cleared and also outside the tile`),
  ];
}

test("source guard: the Charger tile holds exactly what New charger clears", () => {
  // Guard on the guard: the shipped shape passes, and so does a section nested
  // in the tile; a kept input moved in, a cleared one moved out, a second copy
  // outside, a commented-out tile and a missing one all fail.
  const cleared = clearedControls(["yourRate"], ["taxRows"]);
  const head = '<input id="yourRate" />\n<label><input type="radio" name="rateMode" /></label>';
  const foot = '<div id="taxRows"></div>\n<input id="chargeForMin" type="range" />';
  const page = (inside, after = "") =>
    `<section class="card"><input id="gasPrice" /></section>\n<section class="card" id="chargerTile">\n${inside}\n</section>\n<details><input id="startPct" type="range" /></details>\n${after}`;
  assert.deepEqual(chargerTileMismatch(page(`${head}\n${foot}`), cleared), []);
  assert.deepEqual(chargerTileMismatch(page(`<section>${head}</section>\n${foot}`), cleared), []);
  const bad = {
    "a kept input moved in": page(`${head}\n${foot}\n<input id="powerKw" />`),
    "a cleared input moved out": page(`${head}\n<div id="taxRows"></div>`, '<input id="chargeForMin" type="range" />'),
    "a second copy outside": page(`${head}\n${foot}`, '<div id="taxRows"></div>'),
    "a commented-out tile": `<!-- ${page(`${head}\n${foot}`)} -->`,
    "no tile at all": page(`${head}\n${foot}`).replace(' id="chargerTile"', ""),
  };
  for (const [what, html] of Object.entries(bad)) {
    assert.notDeepEqual(chargerTileMismatch(html, cleared), [], `${what}, and the guard passed it`);
  }

  const html = read("../index.html");
  assert.ok(controlsIn(html).length >= 12, "too few inputs found in index.html: the page scan broke");
  assert.deepEqual(
    chargerTileMismatch(html, clearedControls(CHARGER_KEYS, chargerRowIdsIn(read("../js/main.js")))),
    [],
    "the Charger tile in index.html no longer holds exactly what New charger clears, so the pill under its heading keeps something it seems to clear, or clears something it never showed",
  );
});

// The Gas tile's title is an h2 like "Charger" and is also the gasPrice label,
// so tapping it focuses the field and main.js can rewrite it by id.
function gasTitleProblem(html) {
  const live = html.replace(/<!--[\s\S]*?-->/g, "");
  const input = live.indexOf('<input id="gasPrice"');
  if (input < 0) return "no gasPrice input";
  const tile = live.slice(live.lastIndexOf("<section", input), live.indexOf("</section>", input));
  const head = tile.match(/<h2 class="card__title">([\s\S]*?)<\/h2>/);
  if (!head) return "the Gas tile has no card__title h2";
  if (!/^<label for="gasPrice" id="gasPriceLabel">[^<]+<\/label>$/.test(head[1].trim())) return "its h2 is not the gasPrice label";
  if (tile.indexOf(head[0]) > tile.indexOf('<input id="gasPrice"')) return "its title comes after the field";
  if (live.split('for="gasPrice"').length !== 2) return "gasPrice has another label";
  return null;
}

test("source guard: the Gas tile's title is a heading that is the gasPrice label", () => {
  const tile = (inner) => `<section class="card result"></section>\n<section class="card"><div class="field">${inner}<input id="gasPrice" /></div></section>`;
  const label = '<label for="gasPrice" id="gasPriceLabel">Gas price ($/gallon)</label>';
  assert.equal(gasTitleProblem(tile(`<h2 class="card__title">${label}</h2>`)), null);
  const bad = {
    "the old grey label": tile(label),
    "a heading beside the label": tile(`<h2 class="card__title"></h2>${label}`),
    "the id on the heading": tile(`<h2 class="card__title" id="gasPriceLabel"><label for="gasPrice">Gas price</label></h2>`),
    "a heading over another field's label": tile(`<h2 class="card__title">${label.replace('"gasPrice"', '"yourRate"')}</h2>`),
    "a commented-out heading": tile(`<!-- <h2 class="card__title">${label}</h2> -->${label}`),
  };
  for (const [what, html] of Object.entries(bad)) {
    assert.notEqual(gasTitleProblem(html), null, `${what}, and the guard passed it`);
  }
  assert.equal(gasTitleProblem(read("../index.html")), null, "the Gas tile's title in index.html is no longer an h2 that is the gasPrice label");
});

// Every rule in a sheet, @media blocks included, in source order: its
// selectors, evenly spaced, and its [property, value] declarations.
function cssRules(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{([^{}]*)\}/g)].map(([, head, body]) => ({
    selectors: head.split(",").map((s) => s.trim().replace(/\s*([>+~])\s*/g, " $1 ").replace(/\s+/g, " ")),
    decls: body.split(";").map((d) => d.split(":")).filter((p) => p.length > 1).map(([p, ...v]) => [p.trim(), v.join(":").trim()]),
  }));
}

// A selector for a label inside a .card__title, as its child or deeper.
function labelInTitle(selector) {
  const parts = selector.split(" ");
  const title = parts.findLastIndex((p) => /\.card__title(?![\w-])/.test(p));
  return /^label(?![\w-])/.test(parts.at(-1)) && title >= 0 && title < parts.length - 1
    && !parts.slice(title).some((p) => p === "+" || p === "~");
}

// The Gas title is a label inside h2.card__title: it reads as the title only
// while it takes the heading's font and color, and the whole row focuses the
// field only while it is a block. Every rule for such a label, wherever it
// sits, may set those to nothing else, so a later override is caught too.
function titleLabelProblems(css) {
  const decls = cssRules(css).filter((r) => r.selectors.some(labelInTitle)).flatMap((r) => r.decls);
  const problems = decls
    .filter(([p, v]) => (p === "display" ? v !== "block" : (p === "color" || /^font(?:-|$)|^line-height$/.test(p)) && v !== "inherit"))
    .map(([p, v]) => `${p}: ${v}`);
  for (const [p, v] of [["display", "block"], ["font", "inherit"], ["color", "inherit"]]) {
    if (!decls.some((d) => d[0] === p && d[1] === v)) problems.push(`no ${p}: ${v}`);
  }
  return problems;
}

test("source guard: the Gas title's label takes the heading's font and color, across the row", () => {
  // Guard on the guard: the shipped rule passes beside the grey field label
  // rule it outranks; a deleted rule, the rule without display: block, and a
  // color: var(--muted) or font-weight: 600 override later in the sheet (also
  // in a selector list or an @media block) each fail.
  const RULE = ".card__title > label { display: block; font: inherit; color: inherit; }";
  const FIELD = "label {\n  font-size: 14px;\n  font-weight: 600;\n  color: var(--muted);\n}";
  assert.deepEqual(titleLabelProblems(`${RULE}\n${FIELD}`), []);
  const bad = {
    "a deleted rule": FIELD,
    "no display: block": `${RULE.replace("display: block; ", "")}\n${FIELD}`,
    "a later color: var(--muted)": `${RULE}\n${FIELD}\n.card__title label { color: var(--muted); }`,
    "a later font-weight: 600": `${RULE}\n${FIELD}\n.field > .card__title > label { font-weight: 600; }`,
    "an override in a selector list": `${RULE}\n.result__label, .card__title>label { color: var(--muted); }`,
    "an override in an @media block": `${RULE}\n@media (max-width: 380px) {\n  .card__title > label { font-weight: 600; }\n}`,
  };
  for (const [what, css] of Object.entries(bad)) {
    assert.notDeepEqual(titleLabelProblems(css), [], `${what}, and the guard passed it`);
  }
  assert.deepEqual(
    titleLabelProblems(read("../css/styles.css")),
    [],
    "the Gas title's label no longer takes its heading's font and color (it goes back to the grey 14px/600 field label) or no longer spans the title row, so a tap beside the text focuses nothing",
  );
});

