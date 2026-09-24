// assets.test.mjs - pins the two hand-maintained asset lists (service-worker.js
// ASSETS and main.js UPDATE_FINGERPRINT_ASSETS) to main.js's import graph.
// Run with:  node --test
// No framework, no dependencies (uses the built-in node:test runner).
// Source scans, not behavior tests: neither file can be imported here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

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
// Read as a GATE inside askRemoveCar, not as two substrings anywhere in the
// file. Unscoped, any unrelated window.confirm( in main.js stood in for this
// one, and a confirm whose answer was taken and then ignored counted as a
// working fallback.
function dialogFallback(src) {
  const body = bodyOf(src, "askRemoveCar");
  if (!/typeof\s+\w+\.showModal\s*!==\s*["']function["']/.test(body)) return false;
  // The answer has to be SPENT: asked in a condition, with the removal hanging
  // off it. Either way round, because the refusal may be the early return.
  return /if\s*\(\s*!?\s*window\.confirm\(/.test(body) && body.includes("removeActiveCar()");
}

test("the remove-car control still works on engines without <dialog>", () => {
  const ask = (lines) => `function askRemoveCar() {\n${lines}\n}\n`;

  // Guard on the guard: a bare call, and a feature test that bails rather than asks.
  assert.equal(dialogFallback(ask("  dlg.showModal();")), false);
  assert.equal(dialogFallback(ask('  if (typeof dlg.showModal !== "function") return;')), false);

  // One that ASKS and throws the answer away, which the old substring pair
  // passed: the question is drawn, "Keep it" is pressed, the car goes anyway.
  assert.equal(
    dialogFallback(ask('  if (typeof dlg.showModal !== "function") {\n    window.confirm(q);\n    removeActiveCar();\n  }')),
    false,
  );

  // And a confirm belonging to a different control, which is exactly what an
  // unscoped scan could not tell from this one.
  const elsewhere = "function resetEverything() {\n  if (window.confirm(q)) removeActiveCar();\n}\n";
  assert.equal(dialogFallback(elsewhere + ask('  if (typeof dlg.showModal !== "function") return;')), false);

  // Both gating shapes pass: the answer spent where it is taken, and the
  // refusal taken as an early return.
  assert.equal(
    dialogFallback(ask('  if (typeof dlg.showModal !== "function") {\n    if (window.confirm(q)) removeActiveCar();\n  }')),
    true,
  );
  assert.equal(
    dialogFallback(ask('  if (typeof dlg.showModal !== "function") {\n    if (!window.confirm(q)) return;\n    removeActiveCar();\n  }')),
    true,
  );

  assert.equal(
    dialogFallback(read("../js/main.js")),
    true,
    "askRemoveCar reaches showModal() with no confirm gating the removal: below Firefox 98 / Safari 15.4 the remove control does nothing at all",
  );
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

test("source guard: the saved-cars events are all still sent", () => {
  // A positive match, unlike the bans above, because here the literal IS the
  // metric: a renamed event is not a broken test, it is a series that stops in
  // GoatCounter and a new one that starts with no history.
  const src = stripComments(read("../js/main.js"));
  for (const name of ["cars-added", "cars-second-added", "cars-copy-added", "cars-switched", "storage-refused"]) {
    assert.ok(src.includes(`"${name}"`), `${name} is no longer sent from main.js: the saved-cars feature lost a metric`);
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

// The session total and the all-in $/kWh are worked out before the break-even
// is ever consulted and neither depends on it, yet the whole card used to
// collapse to an ellipsis the moment the break-even went NaN. Read as a GATE
// and not as substrings in the arm, because the regression to catch is an arm
// that names session.totalCost and then hides everything anyway.

// From the first `open` at or after `from`, the index of its match, or -1. A
// ${} inside a template literal balances, so a scan of source text holds.
function matchDelim(s, from, open, close) {
  const start = s.indexOf(open, from);
  if (start === -1) return -1;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return i;
  }
  return -1;
}

// The `!Number.isFinite(be)` arm of render(), brace-matched so the `else if`
// arms that follow it cannot stand in for it.
function noGasArm(src) {
  const body = bodyOf(src, "render");
  const start = body.indexOf("if (!Number.isFinite(be))");
  assert.notEqual(start, -1, "the no-break-even arm of render() moved or was renamed");
  const end = matchDelim(body, start, "{", "}");
  assert.notEqual(end, -1, "the no-break-even arm has no closing brace");
  return body.slice(start, end + 1);
}

// That arm's two cases: the one that has a price to show and the bare one.
// null when the arm never splits, which is what the collapsed version was.
function noGasCases(src) {
  const arm = noGasArm(src);
  const ifAt = arm.indexOf("if (", arm.indexOf("{") + 1);
  if (ifAt === -1) return null;
  const condEnd = matchDelim(arm, ifAt, "(", ")");
  const pricedEnd = matchDelim(arm, condEnd, "{", "}");
  const elseAt = arm.indexOf("else", pricedEnd);
  if (condEnd === -1 || pricedEnd === -1 || elseAt === -1) return null;
  const bareEnd = matchDelim(arm, elseAt, "{", "}");
  if (bareEnd === -1) return null;
  return {
    cond: arm.slice(arm.indexOf("(", ifAt) + 1, condEnd),
    priced: arm.slice(arm.indexOf("{", condEnd) + 1, pricedEnd),
    bare: arm.slice(arm.indexOf("{", elseAt) + 1, bareEnd),
  };
}

// The right-hand side of one assignment inside a case, "" when there is none.
const rhs = (block, target) =>
  (new RegExp(`${target.replace(".", "\\.")}\\s*=([^;]*);`).exec(block)?.[1] ?? "").trim();

// A sample render() shaped like the real one, for the guards on the guard.
const asRender = (inner) => `function render() {\n  if (!Number.isFinite(be)) {\n${inner}\n  }\n}\n`;
const COLLAPSED = asRender('    headline.textContent = "\\u2026";\n    detailLine.hidden = true;');

test("source guard: the card prices the charge even with no gas price to judge it against", () => {
  // Guard on the guard: the arm as it used to be has no priced case at all, so
  // every assertion below would otherwise be reading an empty string.
  assert.equal(noGasCases(COLLAPSED), null);

  const c = noGasCases(read("../js/main.js"));
  assert.notEqual(c, null, "the no-gas-price arm no longer has a case that shows a price: it collapses to an ellipsis again");

  assert.match(
    rhs(c.priced, "headline.textContent"),
    /session\.totalCost/,
    "the headline with no gas price is not the session total, so a cost we had already worked out is withheld",
  );

  assert.match(
    c.priced,
    /detailLine\.hidden\s*=\s*false/,
    "the detail line is hidden with no gas price, so the all-in $/kWh is withheld",
  );
  assert.doesNotMatch(
    c.priced,
    /detailLine\.hidden\s*=\s*true/,
    "the priced case shows the detail line and then hides it again",
  );

  const detail = rhs(c.priced, "detailLine.textContent");
  assert.match(detail, /showEffective/, "the detail line ignores showEffective, so a flat no-fee rate is relabelled as effective");
  assert.match(detail, /\beffective\b/, "the detail line with no gas price never shows the effective rate");
  assert.match(detail, /m\.yourRate/, "the showEffective=false half of the detail line is gone");
  assert.doesNotMatch(detail, /break-even/, "the detail line quotes a break-even that is NaN in this state");

  assert.match(
    c.priced,
    /timeline\.hidden\s*=\s*false/,
    "the how-long line is hidden with no gas price, though the duration does not depend on one",
  );

  assert.match(
    rhs(c.priced, "card.dataset.verdict"),
    /"none"/,
    'the no-gas-price card claims a verdict colour; only "none" maps to --muted in styles.css, the rest imply an answer we have not given',
  );

  // The nudge is the whole reason this state is not a dead end.
  assert.match(rhs(c.priced, "sub.textContent"), /gas price/, "the priced case stopped telling the user what a gas price would unlock");

  // And the bare case is still bare.
  assert.match(c.bare, /detailLine\.hidden\s*=\s*true/, "the case with nothing to price now shows a detail line with nothing in it");
  assert.match(rhs(c.bare, "headline.textContent"), /\\u2026|\u2026/, "the case with nothing to price lost its placeholder headline");
});

test("source guard: a charge we cannot size is never given a price", () => {
  // chargeCurve returns totalCost = sessionFee * taxFactor with no battery, no
  // power or no valid start/target, so an ungated headline prints the bare
  // session fee as if it were the price of the whole charge.
  const gated = (src) => {
    const c = noGasCases(src);
    return c !== null && /\bhasRate\b/.test(c.cond) && /\bkwh\s*>\s*0/.test(c.cond);
  };

  // Guard on the guard: the collapsed arm, and the half-gated version that
  // prices a charge whose size is unknown.
  assert.equal(gated(COLLAPSED), false);
  assert.equal(gated(asRender("    if (hasRate) {\n      x();\n    } else {\n      y();\n    }")), false);
  assert.equal(gated(asRender("    if (hasRate && kwh > 0) {\n      x();\n    } else {\n      y();\n    }")), true);

  assert.equal(
    gated(read("../js/main.js")),
    true,
    "the no-gas-price headline is not gated on both a charger rate and a real kWh, so it prints the session fee alone as the price of a charge whose size is unknown",
  );
});

// --- What the effective rate says it includes -------------------------------

// The note is lifted out of the source and RUN, because the four answers are
// the thing to pin and a scan for literals cannot tell " incl. tax" being
// returned from it merely being present. bodyOf stops short of the closing
// brace, hence the one added back.
const liftNote = (src) => new Function(`${bodyOf(src, "inclusionNote")}\n}\nreturn inclusionNote;`)();

// The detail line of both cards: the priced no-gas-price one and the verdict.
const effectiveLines = (src) => bodyOf(src, "render").split("\n").filter((l) => l.includes("`Effective "));

// A sales tax is not a fee, but hasFees folds one in (deliberately: showEffective
// wants either). Hung off that, the note called a tax-only rate "incl. fees".
test("source guard: the effective-rate note names a tax as a tax", () => {
  // Guard on the guard: the lift has to run the function it names, or every
  // answer below is really the same answer.
  const sample = 'function inclusionNote(hasTax, hasFee) {\n  return hasTax ? "T" : hasFee ? "F" : "";\n}\n';
  assert.equal(liftNote(sample)(true, false), "T");
  assert.equal(liftNote(sample)(false, true), "F");

  const note = liftNote(read("../js/main.js"));
  assert.equal(note(true, false), " incl. tax", "a sales tax on its own is still reported as a fee");
  assert.equal(note(false, true), " incl. fees", "the session and per-hour fees lost their name");
  assert.equal(note(true, true), " incl. tax and fees", "a rate carrying both names only one of them");
  assert.equal(note(false, false), "", "the note appears with neither a tax nor a fee behind it");
});

test("source guard: both detail lines take that note from the one place it is worked out", () => {
  // Guard on the guard: the wording inlined per site is what this replaced, and
  // it has to be told from the shared value.
  const inlined = '    ? `Effective ${money(effective, cur)}/kWh${hasFees ? " incl. fees" : ""}`';
  assert.equal(effectiveLines(asRender(inlined)).length, 1, "the detail-line scan cannot see a detail line");
  assert.match(effectiveLines(asRender(inlined))[0], /incl\./, "the detail-line scan cannot see inlined wording");
  assert.equal(effectiveLines(asRender("    ? `You pay ${money(m.yourRate, cur)}/kWh`")).length, 0);

  const lines = effectiveLines(read("../js/main.js"));
  assert.equal(lines.length, 2, `${lines.length} effective-rate detail lines in render(), expected 2: a new one has to share the note too`);
  for (const line of lines) {
    assert.match(line, /\$\{inclNote\}/, "a detail line works out what the rate includes on its own, so the two cards can word it differently");
    assert.doesNotMatch(line, /incl\./, "a detail line spells the wording out inline, which is how the two cards drift apart");
  }
});
