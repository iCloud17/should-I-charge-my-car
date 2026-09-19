// storage.test.mjs - assertions for prefs persistence and the per-car override merge.
// Run with:  node --test
// No framework, no dependencies (uses the built-in node:test runner).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  loadPrefs, savePrefs, mergeCarOverride, defaultPrefs, DEFAULT_PREFS,
  applyCarEdit, applyCarSelection, persistableFrom, resetPrefs,
  sanitizePrefs, PERSIST_KEYS,
} from "../js/storage.js";
import { chargeDrawKw, MAX_OUTLET_KW } from "../js/cars.js";
// Imported to prove a point rather than to test theme.js: sanitizePrefs
// deliberately leaves themeMode alone, and these are the rules that make that
// safe. See "themeMode is passed through" below.
import { resolveTheme, nextThemeMode } from "../js/theme.js";

const KEY = "sicc.prefs.v1";

// Two cars that sit either side of a Level 2 outlet, so a cap shows up as a
// changed number rather than a coincidence.
const SLOW_CAR = { id: "slow-phev", mpg: 25, miPerKwh: 2.4, batteryKwh: 12, chargeKw: 3.3 };
const FAST_CAR = { id: "fast-phev", mpg: 38, miPerKwh: 2.6, batteryKwh: 18, chargeKw: 7.4 };

// One render pass's canonical model: what readInputs() hands to persistFrom.
function liveModel(over = {}) {
  return {
    gasPrice: 3.899, yourRate: 0.48, mpg: 38, miPerKwh: 2.6, batteryKwh: 18.1,
    sessionFee: 1.5, powerKw: 6.6, startPct: 20, targetPct: 90,
    ...over,
  };
}

// A fake localStorage: only the three methods storage.js touches, backed by a Map.
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

// Install a store holding `raw` under the prefs key, as if a previous session
// (or a tamperer) had written it. No argument means an empty store.
function seed(raw) {
  globalThis.localStorage = fakeStorage(raw === undefined ? {} : { [KEY]: raw });
  return globalThis.localStorage;
}

beforeEach(() => { seed(); });

// --- mergeCarOverride: the rule that a blank field must not erase a saved one ---

test("mergeCarOverride keeps the saved value when the new one isn't a positive number", () => {
  const existing = { mpg: 25, miPerKwh: 2.4, batteryKwh: 20 };
  for (const bad of [NaN, null, undefined, "31", Infinity, -Infinity, {}, true, 0, -3]) {
    const out = mergeCarOverride(existing, { ...existing, mpg: bad });
    assert.equal(out.mpg, 25, `${String(bad)} must not overwrite a saved value`);
  }
});

test("mergeCarOverride accepts a positive number and nothing else", () => {
  assert.equal(mergeCarOverride({ mpg: 25 }, { mpg: 31.5 }).mpg, 31.5);
  assert.equal(mergeCarOverride({ mpg: 25 }, { mpg: 1e-9 }).mpg, 1e-9, "however small");
  // The QA case, closed at the write end rather than the read end. A zero MPG
  // used to be written, shown in the field all session, and dropped on the next
  // load by the stricter read rule, so the user lost a number they watched the
  // app accept. Now it never lands.
  assert.equal(mergeCarOverride({ mpg: 25 }, { mpg: 0 }).mpg, 25);
  assert.equal(mergeCarOverride({ mpg: 25 }, { mpg: -3 }).mpg, 25);
  // With nothing saved to fall back to, the field is simply absent.
  assert.deepEqual(mergeCarOverride(undefined, { mpg: 0, batteryKwh: -1 }), {});
});

test("typing a decimal that starts with zero is not fought mid-keystroke", () => {
  // The trap in refusing 0 on the way in: "0.5" passes through "0", and parseNum
  // reports that 0 on its own input event. Nothing may snap, clear, or revert -
  // the intermediate value just fails to update the override, and the real one
  // lands when it arrives. Each step below is one keystroke's readInputs.
  const carId = "volt-2018";
  let prefs = applyCarEdit(defaultPrefs(), carId, { mpg: 25, miPerKwh: 2.4, batteryKwh: 20 });
  for (const typed of [NaN, 0, 0, 0.5]) { // cleared, "0", "0.", "0.5"
    prefs = applyCarEdit(prefs, carId, { mpg: typed, miPerKwh: 2.4, batteryKwh: 20 });
    assert.ok(prefs.carOverrides[carId].mpg > 0, `a ${String(typed)} must never leave a junk value behind`);
  }
  assert.equal(prefs.carOverrides[carId].mpg, 0.5, "and the value the user meant is what is saved");
  assert.equal(prefs.carOverrides[carId].miPerKwh, 2.4, "with the untouched fields untouched");
});

test("mergeCarOverride handles having no existing override", () => {
  assert.deepEqual(mergeCarOverride(undefined, { mpg: 25, batteryKwh: 20 }), { mpg: 25, batteryKwh: 20 });
  assert.deepEqual(mergeCarOverride(null, { mpg: 25 }), { mpg: 25 });
  assert.deepEqual(mergeCarOverride(undefined, {}), {});
  assert.deepEqual(mergeCarOverride(undefined, undefined), {});
});

test("mergeCarOverride does not mutate its inputs", () => {
  const existing = { mpg: 25 };
  const incoming = { mpg: NaN, batteryKwh: 20 };
  const out = mergeCarOverride(existing, incoming);
  assert.deepEqual(existing, { mpg: 25 });
  assert.deepEqual(incoming, { mpg: NaN, batteryKwh: 20 });
  assert.notEqual(out, existing);
  assert.notEqual(out, incoming);
});

test("mergeCarOverride returns only the known numeric fields", () => {
  const out = mergeCarOverride(
    { mpg: 25, junk: "keep me out" },
    { batteryKwh: 20, miPerKwh: "2.4", somethingElse: 1 },
  );
  assert.deepEqual(out, { mpg: 25, batteryKwh: 20 });
});

test("the write path and the read path accept exactly the same numbers", () => {
  // The coherence pin, in the direction the earlier one did not cover. The read
  // end (safeOverrides) and the write end (mergeCarOverride) are gates on the
  // same quantity, and while they disagreed, whatever the looser one let past
  // lived in the field until a reload quietly took it away. Let them diverge
  // again and 0 walks back in through the same door it used the first time.
  for (const field of ["mpg", "miPerKwh", "batteryKwh"]) {
    for (const v of [...BAD_NUMBERS, -99, -0.5, 0, 1e-9, 42]) {
      const written = mergeCarOverride(undefined, { [field]: v });
      const read = sanitizePrefs({ carOverrides: { a: { [field]: v } } }).carOverrides.a;
      assert.equal(
        Object.hasOwn(written, field),
        read !== undefined && Object.hasOwn(read, field),
        `${field} = ${String(v)}`,
      );
    }
  }
});

test("mergeCarOverride carries the legacy per-car powerKw through untouched", () => {
  // The rollback contract: carOverrides[*].powerKw is data nothing reads, kept
  // alive by this merge alone. The write path never sends a powerKw, so what
  // preserves it is that it's still in OVERRIDE_KEYS and falls through to the
  // saved value - on every car edit, since applyCarEdit's result goes to
  // savePrefs. Narrow OVERRIDE_KEYS to the three live fields and the first edit
  // to ANY field on a car deletes that car's rollback data. This is the test
  // that makes that go red instead of quiet.
  assert.equal(mergeCarOverride({ mpg: 25, powerKw: 3.3 }, { mpg: 31 }).powerKw, 3.3);
  assert.deepEqual(
    mergeCarOverride({ mpg: 25, miPerKwh: 2.4, powerKw: 3.3 }, { mpg: 31, miPerKwh: 2.4, batteryKwh: 20 }),
    { mpg: 31, miPerKwh: 2.4, batteryKwh: 20, powerKw: 3.3 },
  );
});

test("a saved override survives a write made while one field is blank", () => {
  // The regression: the writer rebuilt the whole override from the live DOM, so
  // clearing the MPG box to retype it stored null, safeOverrides dropped it on
  // the next load, and the user's 25 silently reverted to the dataset number.
  const carId = "outlander-phev-2023";
  const first = loadPrefs();
  first.carOverrides[carId] = mergeCarOverride(undefined, { mpg: 25, miPerKwh: 2.4, batteryKwh: 20 });
  savePrefs(first);

  const midEdit = loadPrefs();
  midEdit.carOverrides[carId] = mergeCarOverride(midEdit.carOverrides[carId], {
    mpg: NaN, miPerKwh: 2.4, batteryKwh: 20, // MPG box is momentarily empty
  });
  savePrefs(midEdit);

  assert.deepEqual(loadPrefs().carOverrides[carId], { mpg: 25, miPerKwh: 2.4, batteryKwh: 20 });
});

// --- safeOverrides, reached through loadPrefs ---

test("loadPrefs drops override fields that aren't finite numbers", () => {
  seed(JSON.stringify({
    carOverrides: {
      a: { mpg: 25, miPerKwh: null, batteryKwh: "20" }, // null is what JSON does to NaN
      b: { mpg: "nope" }, // nothing usable left, so the entry goes too
      c: null,
      d: 7,
    },
  }));
  assert.deepEqual(loadPrefs().carOverrides, { a: { mpg: 25 } });
});

test("loadPrefs keeps the legacy per-car powerKw so a rollback still finds it", () => {
  seed(JSON.stringify({ carOverrides: { a: { mpg: 25, powerKw: 3.3 } } }));
  assert.deepEqual(loadPrefs().carOverrides.a, { mpg: 25, powerKw: 3.3 });
});

test("loadPrefs drops override numbers that aren't above zero", () => {
  // The QA case. These are finite, so the old finite-only check kept them, and
  // applyCarSelection then promoted them into the mpg, mi/kWh and battery
  // inputs, where every render read them back and saved them again. parseNum
  // refuses negatives so the verdict stayed blank and nothing wrong was
  // computed, but nothing removed the junk either.
  seed(JSON.stringify({
    carOverrides: {
      a: { mpg: -99, miPerKwh: -3, batteryKwh: -4 }, // nothing usable left, so the entry goes
      b: { mpg: 0, miPerKwh: 2.4 }, // a zero economy is a division by zero, not a setting
      c: { mpg: 42, batteryKwh: -1 }, // dropped per field: the good mpg stays
    },
  }));
  assert.deepEqual(loadPrefs().carOverrides, { b: { miPerKwh: 2.4 }, c: { mpg: 42 } });
});

test("the legacy per-car powerKw is held to the same rule, and a real one passes it", () => {
  seed(JSON.stringify({
    carOverrides: {
      a: { mpg: 25, powerKw: 3.3 },
      b: { mpg: 25, powerKw: -3.3 }, // being legacy is not an exemption from being a number
      c: { mpg: 25, powerKw: 50 },
    },
  }));
  const out = loadPrefs().carOverrides;
  assert.deepEqual(out.a, { mpg: 25, powerKw: 3.3 }, "the rollback data still round trips");
  assert.deepEqual(out.b, { mpg: 25 });
  // Kept on purpose. MAX_OUTLET_KW bounds the OUTLET, and this value is a car's
  // onboard ceiling, so the outlet rule has no business dropping it. An old
  // release reading it back still ends up bounded, because chargeDrawKw takes
  // the minimum of the outlet, MAX_OUTLET_KW and the car.
  assert.deepEqual(out.c, { mpg: 25, powerKw: 50 });
});

test("a corrupt saved override can't reach the car's visible numbers", () => {
  // End to end, because the gap was only visible downstream: applyCarSelection
  // prefers a saved override over the dataset number, so a stored -99 was what
  // the mpg field showed the moment the car was picked.
  seed(JSON.stringify({ carOverrides: { [SLOW_CAR.id]: { mpg: -99, miPerKwh: -3, batteryKwh: -4 } } }));
  const prefs = applyCarSelection(loadPrefs(), SLOW_CAR);
  assert.equal(prefs.mpg, SLOW_CAR.mpg);
  assert.equal(prefs.miPerKwh, SLOW_CAR.miPerKwh);
  assert.equal(prefs.batteryKwh, SLOW_CAR.batteryKwh);
});

test("loadPrefs ignores prototype-polluting override keys", () => {
  // Built as a raw string on purpose: a __proto__ key in an object literal sets
  // the prototype rather than becoming the own property JSON.parse would create.
  seed('{"carOverrides":{'
    + '"__proto__":{"mpg":99},'
    + '"constructor":{"mpg":98},'
    + '"prototype":{"mpg":97},'
    + '"honda-clarity":{"mpg":42}}}');
  const out = loadPrefs().carOverrides;
  assert.deepEqual(out, { "honda-clarity": { mpg: 42 } });
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(Object.prototype.mpg, undefined);
  assert.equal({}.mpg, undefined);
});

// --- Untrusted input: localStorage is fully user-editable ---
//
// Most of these go through sanitizePrefs directly rather than through the
// store. NaN and Infinity cannot survive JSON.stringify, but nothing obliges a
// hand-edited store to be something we wrote, and sanitizePrefs is the function
// that has to hold either way.

// The numbers that must be finite and above zero, each with the default it
// falls back to when the stored value is not.
const POSITIVE_FIELDS = { mpg: null, miPerKwh: null, batteryKwh: null, gasPrice: null, powerKw: 6.6 };

const BAD_NUMBERS = [null, undefined, NaN, Infinity, -Infinity, "42", "", -1, 0, true, {}, []];

test("a numeric field holding anything but a positive number falls back to its default", () => {
  for (const [field, fallback] of Object.entries(POSITIVE_FIELDS)) {
    for (const bad of BAD_NUMBERS) {
      const out = sanitizePrefs({ [field]: bad });
      assert.equal(out[field], fallback, `${field} = ${String(bad)}`);
    }
  }
});

test("a numeric field holding a positive number is kept exactly", () => {
  const good = { mpg: 42, miPerKwh: 3.1, batteryKwh: 17, gasPrice: 3.899, powerKw: 3.3 };
  const out = sanitizePrefs(good);
  for (const [field, v] of Object.entries(good)) assert.equal(out[field], v, field);
});

test("an override field and its top-level mirror accept exactly the same numbers", () => {
  // The coherence pin. mpg inside carOverrides and mpg at the top level are the
  // same quantity, and for a while they had two sanitizers applying two rules:
  // positive at the top, merely finite per car. Whatever sanitizePrefs keeps in
  // one place it has to keep in the other, and whatever it drops it has to drop
  // in both. Let these diverge again and the looser one becomes the way in.
  for (const field of ["mpg", "miPerKwh", "batteryKwh"]) {
    for (const v of [...BAD_NUMBERS, -99, -3, -0.5, 1e-9, 42]) {
      const keptAtTop = sanitizePrefs({ [field]: v })[field] !== DEFAULT_PREFS[field];
      const perCar = sanitizePrefs({ carOverrides: { a: { [field]: v } } }).carOverrides.a;
      const keptPerCar = perCar !== undefined && Object.hasOwn(perCar, field);
      assert.equal(keptPerCar, keptAtTop, `${field} = ${String(v)}`);
    }
  }
});

test("an outlet power past the AC ceiling falls back to the default, not to the ceiling", () => {
  // Clamping would hand back a socket the user never plugged into, and the next
  // render reads the field and saves it, so the invention becomes their setting.
  for (const bad of [MAX_OUTLET_KW + 0.1, 50, 350, 99999999]) {
    assert.equal(sanitizePrefs({ powerKw: bad }).powerKw, DEFAULT_PREFS.powerKw, `powerKw = ${bad}`);
  }
  assert.equal(sanitizePrefs({ powerKw: MAX_OUTLET_KW }).powerKw, MAX_OUTLET_KW, "the ceiling itself is a real outlet");
});

test("neither battery percentage is ever read back out of the store", () => {
  // They left PERSIST_KEYS, and sanitizePrefs reads that list and nothing else,
  // so a stored value for either is not dropped by a rule - it is never looked
  // up. Valid, invalid and absurd all land on the documented default, which is
  // the point: where the battery is and how full you want it are facts about
  // one stop, and last week's answer restored as this week's is a plausible
  // wrong number wearing the user's own authority.
  for (const v of [...BAD_NUMBERS, 5, 37, 95, 100, 101, -0.1, 1e9]) {
    assert.equal(sanitizePrefs({ startPct: v }).startPct, 0, `startPct = ${String(v)}`);
    assert.equal(sanitizePrefs({ targetPct: v }).targetPct, 100, `targetPct = ${String(v)}`);
  }
});

test("a stored startPct of null comes back as 0, never as a made-up 50", () => {
  // The original defect, kept as a regression pin even though what stops it has
  // changed underneath. The slider runs 0 to 100. Handed null it cannot hold the
  // value and falls back to the midpoint of its own min and max, so the app came
  // up claiming a 50% starting charge and the next render saved that 50 as if it
  // were chosen. A rule used to drop the null; now the key is not read at all.
  // Either way the number the user sees is the documented 0.
  seed(JSON.stringify({ ...DEFAULT_PREFS, startPct: null }));
  const out = loadPrefs();
  assert.equal(out.startPct, 0);
  assert.notEqual(out.startPct, 50);
});

test("a crossed pair in the store cannot reach the app at all", () => {
  // This used to be an open product question: a stored start above a stored
  // target is two individually valid numbers in a surprising order, and
  // writeDisplayValues answered it by pulling the start down to the target,
  // after which the render saved that - seed 90/20 and the store held 20/20
  // with the 90 gone. Not persisting either number retires the question rather
  // than answering it. A crossed pair can never be LOADED, so the fix-up has
  // nothing to fix and the repair-then-save loop has no way to start.
  const out = sanitizePrefs({ startPct: 90, targetPct: 20 });
  assert.equal(out.startPct, 0);
  assert.equal(out.targetPct, 100);
  assert.ok(out.startPct < out.targetPct, "every session opens on an uncrossed pair");
});

test("a carId that isn't a usable string falls back to no car", () => {
  for (const bad of [null, 42, true, {}, [], "", "   ", "\u0000\u0007"]) {
    assert.equal(sanitizePrefs({ carId: bad }).carId, null, `carId = ${JSON.stringify(bad)}`);
  }
});

test("a carId is bounded, and real ones pass through untouched", () => {
  assert.equal(sanitizePrefs({ carId: "x".repeat(5000) }).carId.length, 128);
  // The longest id in the bundled dataset, and the custom-car sentinel.
  for (const id of ["mercedes-benz-amg-e53-hybrid-4matic-plus-station-wagon-2026", "__custom__"]) {
    assert.equal(sanitizePrefs({ carId: id }).carId, id);
  }
});

test("a customName that isn't a string falls back to empty", () => {
  for (const bad of [null, 42, true, {}, []]) {
    assert.equal(sanitizePrefs({ customName: bad }).customName, "", `customName = ${String(bad)}`);
  }
});

test("a customName is stripped of control characters and capped", () => {
  assert.equal(sanitizePrefs({ customName: "Nel\u0000lie\u001b\u009f" }).customName, "Nellie");
  assert.equal(sanitizePrefs({ customName: "x".repeat(500) }).customName.length, 40);
  assert.equal(sanitizePrefs({ customName: "Nellie" }).customName, "Nellie");
});

test("source guard: the nickname cap matches the input's own maxlength", () => {
  // maxlength is a DOM hint a tampered store walks straight past, so storage
  // enforces the same number. If one moves the other has to move with it.
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const input = html.split("\n").find((l) => l.includes('id="carNickname"'));
  assert.ok(input, "the nickname input moved or was renamed");
  assert.match(input, /maxlength="40"/, "storage caps the nickname at 40; keep the markup in step");
});

test("themeMode is passed through, because theme.js is the one place that rule lives", () => {
  // Not an oversight. resolveTheme, nextThemeMode and themeLabel all treat
  // anything that is not "light" or "dark" as auto, so a tampered value paints
  // as auto and cycles back to auto without a second rule in storage.
  const noon = new Date(2026, 0, 1, 12, 0, 0);
  for (const bad of [null, 42, "chartreuse", {}]) {
    const mode = sanitizePrefs({ themeMode: bad }).themeMode;
    assert.equal(resolveTheme(mode, noon), "light", `${String(bad)} paints as auto`);
    assert.equal(nextThemeMode(mode), "auto", `${String(bad)} cycles to auto`);
  }
  assert.equal(sanitizePrefs({ themeMode: "dark" }).themeMode, "dark");
});

test("one bad field never costs a good one", () => {
  // The whole point of checking field by field. safeOverrides already worked
  // this way; everything else now does too.
  seed(JSON.stringify({
    carId: 42, customName: { evil: true }, mpg: -5, miPerKwh: "3.1", batteryKwh: 0,
    gasPrice: 3.899, units: "klingon", currency: "<>&\"'", powerKw: 99999999,
    startPct: null, targetPct: 1e9, themeMode: "dark",
    carOverrides: { "honda-clarity": { mpg: 42 } },
  }));
  const out = loadPrefs();
  assert.equal(out.carId, null);
  assert.equal(out.customName, "");
  assert.equal(out.mpg, null);
  assert.equal(out.miPerKwh, null);
  assert.equal(out.batteryKwh, null);
  assert.equal(out.units, "imperial");
  assert.equal(out.currency, "$");
  assert.equal(out.powerKw, 6.6);
  assert.equal(out.startPct, 0);
  assert.equal(out.targetPct, 100);
  // The ones that were fine are untouched.
  assert.equal(out.gasPrice, 3.899);
  assert.equal(out.themeMode, "dark");
  assert.deepEqual(out.carOverrides, { "honda-clarity": { mpg: 42 } });
});

test("keys the app never persists cannot be pushed in through the store", () => {
  // yourRate and sessionFee change at every stop and are deliberately not
  // saved. A hand-edited store must not hand them back as if they had been.
  const out = sanitizePrefs({ yourRate: 0.99, sessionFee: 12, injected: "x" });
  assert.equal(out.yourRate, null);
  assert.equal(out.sessionFee, 0);
  assert.equal("injected" in out, false);
});

test("a store carrying __proto__ reaches neither the prefs nor Object.prototype", () => {
  // JSON.parse makes __proto__ an OWN property, so it survives into the parsed
  // object and would be walked by anything iterating the store's own keys.
  // Driving the loop off PERSIST_KEYS instead means the name is never looked up.
  seed('{"__proto__":{"pwned":1},"constructor":{"pwned":1},"carId":"honda-clarity","mpg":42}');
  const out = loadPrefs();
  assert.equal(out.pwned, undefined);
  assert.equal({}.pwned, undefined, "Object.prototype must be untouched");
  assert.equal(out.carId, "honda-clarity", "and the good fields still load");
  assert.equal(out.mpg, 42);
});

test("every persisted key survives sanitation when its value is valid", () => {
  // A key added to PERSIST_KEYS with no rule behind it is dropped on every
  // load, silently resetting itself. Handing each key a plainly valid value
  // and demanding it back is what makes that visible.
  const valid = {
    carId: "honda-clarity", customName: "Nellie",
    carOverrides: { "honda-clarity": { mpg: 42 } },
    mpg: 42, miPerKwh: 3.1, batteryKwh: 17, gasPrice: 3.899,
    units: "uk", currency: "£", powerKw: 3.3,
    themeMode: "dark",
  };
  const out = sanitizePrefs(valid);
  for (const k of PERSIST_KEYS) {
    assert.ok(k in valid, `PERSIST_KEYS gained ${k}; give it a value here and a rule in storage.js`);
    assert.deepEqual(out[k], valid[k], k);
  }
});

test("sanitizePrefs does not mutate what it was given", () => {
  const raw = { carId: "honda-clarity", carOverrides: { "honda-clarity": { mpg: 42 } }, mpg: -5 };
  const copy = JSON.parse(JSON.stringify(raw));
  sanitizePrefs(raw);
  assert.deepEqual(raw, copy);
});

// --- round trip and persistence contract ---

test("a valid setup round trips through storage byte for byte", () => {
  // The case that matters most: sanitation must be invisible to everyone whose
  // store was never tampered with.
  const store = seed();
  const saved = {
    carId: "honda-clarity", customName: "Nellie",
    carOverrides: { "honda-clarity": { mpg: 42, miPerKwh: 3.1, batteryKwh: 17 } },
    mpg: 42, miPerKwh: 3.1, batteryKwh: 17, gasPrice: 3.899,
    units: "uk", currency: "£", powerKw: 3.3,
    themeMode: "dark",
  };
  savePrefs({ ...DEFAULT_PREFS, ...saved });
  const before = store.map.get(KEY);

  const out = loadPrefs();
  for (const [k, v] of Object.entries(saved)) assert.deepEqual(out[k], v, k);

  savePrefs(out);
  assert.equal(store.map.get(KEY), before, "a clean load must not rewrite a single byte");
});

test("savePrefs and loadPrefs round trip the stable fields", () => {
  savePrefs({
    ...DEFAULT_PREFS,
    carId: "honda-clarity", customName: "Nellie", mpg: 42, miPerKwh: 3.1,
    batteryKwh: 17, gasPrice: 3.899, units: "uk", currency: "£",
    powerKw: 3.3, themeMode: "dark",
    carOverrides: { "honda-clarity": { mpg: 42 } },
  });
  const out = loadPrefs();
  assert.equal(out.carId, "honda-clarity");
  assert.equal(out.customName, "Nellie");
  assert.equal(out.gasPrice, 3.899); // not rounded away
  assert.equal(out.units, "uk");
  assert.equal(out.currency, "£");
  assert.equal(out.powerKw, 3.3);
  assert.equal(out.themeMode, "dark");
  assert.deepEqual(out.carOverrides, { "honda-clarity": { mpg: 42 } });
});

test("savePrefs writes only the stable keys, not the per-stop ones", () => {
  const store = seed();
  savePrefs({ ...DEFAULT_PREFS, mpg: 25, yourRate: 0.32, sessionFee: 2.5, startPct: 40, targetPct: 80 });
  const saved = JSON.parse(store.map.get(KEY));
  assert.equal(saved.mpg, 25);
  assert.equal("yourRate" in saved, false);
  assert.equal("sessionFee" in saved, false);
  assert.equal("startPct" in saved, false, "a state of charge belongs to one stop");
  assert.equal("targetPct" in saved, false);
  assert.equal(loadPrefs().yourRate, null); // comes back as the default, not 0.32
});

test("a store written by the previous release loads clean and self-cleans on the next save", () => {
  // The upgrade path, and it is a real population: the shipped build persisted
  // startPct and targetPct, so every store out there holds them. PERSIST_KEYS is
  // the whitelist in BOTH directions, which is what makes this a removal rather
  // than a migration - sanitizePrefs never looks the keys up, and savePrefs
  // rebuilds the stored object from the same list, so the stale pair is gone the
  // first time anything is saved. Nothing else may shift on the way through.
  const store = seed(JSON.stringify({
    carId: "honda-clarity", customName: "Nellie",
    carOverrides: { "honda-clarity": { mpg: 42, powerKw: 3.3 } },
    mpg: 42, miPerKwh: 3.1, batteryKwh: 17, gasPrice: 3.899,
    units: "uk", currency: "£", powerKw: 3.3, startPct: 90, targetPct: 20,
    themeMode: "dark",
  }));

  const out = loadPrefs();
  assert.equal(out.startPct, 0, "the stored state of charge is not restored");
  assert.equal(out.targetPct, 100);
  // Everything the user legitimately saved is still exactly theirs.
  assert.equal(out.carId, "honda-clarity");
  assert.equal(out.customName, "Nellie");
  assert.equal(out.mpg, 42);
  assert.equal(out.miPerKwh, 3.1);
  assert.equal(out.batteryKwh, 17);
  assert.equal(out.gasPrice, 3.899);
  assert.equal(out.units, "uk");
  assert.equal(out.currency, "£");
  assert.equal(out.powerKw, 3.3);
  assert.equal(out.themeMode, "dark");
  assert.deepEqual(out.carOverrides, { "honda-clarity": { mpg: 42, powerKw: 3.3 } });

  savePrefs(out);
  const rewritten = JSON.parse(store.map.get(KEY));
  assert.equal("startPct" in rewritten, false, "the stale key is gone, no migration step needed");
  assert.equal("targetPct" in rewritten, false);
  assert.deepEqual(Object.keys(rewritten).sort(), [...PERSIST_KEYS].sort());

  // And a second load is stable: what came back out is what goes back in.
  const again = loadPrefs();
  for (const k of PERSIST_KEYS) assert.deepEqual(again[k], out[k], k);
});

// --- nothing in here may throw: the app has to keep working without storage ---

test("loadPrefs returns defaults when nothing has been saved yet", () => {
  assert.deepEqual(loadPrefs(), DEFAULT_PREFS);
});

test("a returned prefs object never shares carOverrides with the defaults", () => {
  // Saving a per-car edit assigns into prefs.carOverrides. If that's the object
  // living inside DEFAULT_PREFS, the edit leaks into every later "fresh" load
  // and "Reset everything" hands the user their old overrides straight back.
  const first = loadPrefs();
  first.carOverrides["honda-clarity"] = { mpg: 42 };

  assert.deepEqual(DEFAULT_PREFS.carOverrides, {});
  assert.deepEqual(loadPrefs().carOverrides, {});
  assert.deepEqual(defaultPrefs().carOverrides, {});

  const reset = defaultPrefs();
  reset.carOverrides.x = { mpg: 1 };
  assert.deepEqual(defaultPrefs().carOverrides, {});
  assert.deepEqual(DEFAULT_PREFS.carOverrides, {});
});

test("defaultPrefs shares no mutable value with DEFAULT_PREFS", () => {
  // The test above pins carOverrides, which is the only object in DEFAULT_PREFS
  // today. This pins the RULE instead, so adding a second nested value (the
  // saved-cars array is coming) without cloning it in the factory fails here
  // rather than silently reviving the shared-mutable bug.
  const a = defaultPrefs(), b = defaultPrefs();
  for (const [k, v] of Object.entries(DEFAULT_PREFS)) {
    if (v && typeof v === "object") {
      assert.notEqual(a[k], v, `${k} is shared with DEFAULT_PREFS`);
      assert.notEqual(a[k], b[k], `${k} is shared between calls`);
    }
  }
});

test("loadPrefs returns defaults on malformed or non-object stored values", () => {
  for (const raw of ["{not json", "null", "42", '"a string"', "[1,2,3]", "", "undefined"]) {
    seed(raw);
    const out = loadPrefs();
    assert.equal(out.carId, null, `carId for ${raw}`);
    assert.equal(out.units, "imperial", `units for ${raw}`);
    assert.equal(out.currency, "$", `currency for ${raw}`);
    assert.deepEqual(out.carOverrides, {}, `carOverrides for ${raw}`);
  }
});

test("loadPrefs returns defaults when localStorage is absent entirely", () => {
  delete globalThis.localStorage;
  assert.doesNotThrow(() => loadPrefs());
  assert.deepEqual(loadPrefs(), DEFAULT_PREFS);
});

test("loadPrefs returns defaults when reading storage throws", () => {
  globalThis.localStorage = { getItem: () => { throw new Error("SecurityError"); } };
  assert.deepEqual(loadPrefs(), DEFAULT_PREFS);
});

test("savePrefs swallows a quota error instead of breaking the render", () => {
  let attempts = 0;
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {
      attempts++;
      const e = new Error("exceeded the quota");
      e.name = "QuotaExceededError";
      throw e;
    },
  };
  assert.doesNotThrow(() => savePrefs({ ...DEFAULT_PREFS, mpg: 25 }));
  assert.equal(attempts, 1); // it really did try, it just didn't propagate
});

test("savePrefs does not throw when localStorage is absent entirely", () => {
  delete globalThis.localStorage;
  assert.doesNotThrow(() => savePrefs({ ...DEFAULT_PREFS }));
});

// --- applyCarEdit: which fields a per-car edit is allowed to save ---

test("a car edit made while another field is blank keeps the saved value", () => {
  // The regression: the writer rebuilt the whole override from the live fields,
  // so clearing the MPG box to retype it wrote nothing, and the 25 the user had
  // already saved silently reverted to the dataset number on the next load.
  const carId = "outlander-phev-2023";
  let prefs = defaultPrefs();
  prefs = applyCarEdit(prefs, carId, { mpg: 25, miPerKwh: 2.4, batteryKwh: 20 });
  prefs = applyCarEdit(prefs, carId, { mpg: NaN, miPerKwh: 2.4, batteryKwh: 20 });
  assert.deepEqual(prefs.carOverrides[carId], { mpg: 25, miPerKwh: 2.4, batteryKwh: 20 });
});

test("a car override never takes the outlet power from the live fields", () => {
  // powerKw is the OUTLET you're standing at, not a property of the car. Let a
  // car edit save it and a station's power lands in the car's own numbers,
  // where an older release reads it straight back as the car's ceiling. The
  // other live values (gas price, charger rate, session fee) aren't the car's
  // either, so the same rule keeps them out.
  const carId = "rav4-prime-2023";
  const prefs = applyCarEdit(defaultPrefs(), carId, liveModel({
    mpg: 38, miPerKwh: 2.6, batteryKwh: 18.1, powerKw: 3.3,
  }));
  assert.deepEqual(prefs.carOverrides[carId], { mpg: 38, miPerKwh: 2.6, batteryKwh: 18.1 });
});

test("a car edit leaves an already-saved legacy powerKw untouched", () => {
  // The rollback contract: a powerKw already in the store is data nothing
  // reads, and this is the write that keeps it. Editing the car's MPG carries
  // the old value through unchanged - it must neither drop it nor refresh it
  // with whatever outlet the user happens to be standing at now.
  const carId = "volt-2018";
  const prefs = applyCarEdit(
    { ...defaultPrefs(), carOverrides: { [carId]: { mpg: 42, powerKw: 3.3 } } },
    carId,
    liveModel({ mpg: 45, miPerKwh: 2.9, batteryKwh: 18.4, powerKw: 6.6 }),
  );
  assert.equal(prefs.carOverrides[carId].powerKw, 3.3, "the outlet in hand must not overwrite it");
  assert.equal(prefs.carOverrides[carId].mpg, 45, "while the edit itself lands");
});

test("editing one car's numbers leaves every other car's alone", () => {
  const prefs = applyCarEdit(
    { ...defaultPrefs(), carOverrides: { "volt-2018": { mpg: 42 } } },
    "clarity-2018",
    { mpg: 38, miPerKwh: 3.1, batteryKwh: 17 },
  );
  assert.deepEqual(prefs.carOverrides["volt-2018"], { mpg: 42 });
  assert.equal(prefs.carOverrides["clarity-2018"].mpg, 38);
});

test("a number typed before any car is chosen saves no override", () => {
  assert.deepEqual(applyCarEdit(defaultPrefs(), null, { mpg: 42 }).carOverrides, {});
});

test("applyCarEdit does not mutate the prefs it was given", () => {
  const before = defaultPrefs();
  const after = applyCarEdit(before, "clarity-2018", { mpg: 42, miPerKwh: 3.1, batteryKwh: 17 });
  assert.deepEqual(before.carOverrides, {}, "the caller's prefs are untouched");
  assert.equal(after.carOverrides["clarity-2018"].mpg, 42);
});

test("a tampered car id cannot reach Object.prototype through a car edit", () => {
  // carId comes straight out of the store and is never sanitized on load, so
  // treat it as attacker-controlled. A computed key writes an own property
  // rather than moving the prototype, and safeOverrides drops the entry on the
  // way back in, so nothing dangerous survives the round trip.
  for (const carId of ["__proto__", "constructor", "prototype"]) {
    savePrefs(applyCarEdit(defaultPrefs(), carId, { mpg: 99 }));
    const back = loadPrefs().carOverrides;
    assert.deepEqual(Object.keys(back), [], `${carId} survived a reload`);
    assert.equal(Object.getPrototypeOf(back), Object.prototype, `${carId} moved the prototype`);
    assert.equal(Object.prototype.mpg, undefined, `${carId} polluted the prototype`);
    assert.equal({}.mpg, undefined, `${carId} reached a plain object`);
  }
});

// --- applyCarSelection: what picking a car fills in, and what it must not ---

test("picking a car uses its numbers, or the ones the user saved for it", () => {
  const fresh = applyCarSelection(defaultPrefs(), FAST_CAR);
  assert.equal(fresh.carId, "fast-phev");
  assert.equal(fresh.mpg, 38);
  assert.equal(fresh.batteryKwh, 18);

  const edited = applyCarSelection(
    { ...defaultPrefs(), carOverrides: { "fast-phev": { mpg: 34 } } },
    FAST_CAR,
  );
  assert.equal(edited.mpg, 34, "the number the user measured wins");
  assert.equal(edited.miPerKwh, 2.6, "the fields they never edited come from the dataset");
});

test("picking a car never moves the outlet power the user set", () => {
  // The ratchet: writing a car-capped power into prefs only ever lowers it, so
  // one 3.3 kW car left the field pinned at 3.3 for every car chosen after it,
  // on every outlet, until the user noticed and typed it back.
  let prefs = { ...defaultPrefs(), powerKw: 6.6 };
  prefs = applyCarSelection(prefs, SLOW_CAR);
  assert.equal(prefs.powerKw, 6.6, "the outlet is where you're standing, not what the car accepts");
  prefs = applyCarSelection(prefs, FAST_CAR);
  assert.equal(prefs.powerKw, 6.6, "so the next car isn't stuck at the last one's limit");
  // The cap is still enforced, just where the number is used.
  assert.equal(chargeDrawKw(6.6, SLOW_CAR), 3.3, "the slow car still only pulls 3.3");
});

test("applyCarSelection does not mutate the prefs it was given", () => {
  const before = { ...defaultPrefs(), mpg: 25, carOverrides: { "fast-phev": { mpg: 34 } } };
  const after = applyCarSelection(before, FAST_CAR);
  assert.equal(before.carId, null, "the caller's prefs are untouched");
  assert.equal(before.mpg, 25);
  assert.equal(after.mpg, 34);
});

// --- persistableFrom: exactly what a render pass writes to storage ---

test("a render pass saves the typed values, including the raw outlet power", () => {
  const prefs = persistableFrom({ ...defaultPrefs(), carId: "rav4-prime-2023" }, liveModel());
  savePrefs(prefs);
  const back = loadPrefs();
  assert.equal(back.powerKw, 6.6, "the outlet the user typed, never a car-capped value");
  assert.equal(back.gasPrice, 3.899, "at full precision");
  assert.equal(back.carId, "rav4-prime-2023", "a render pass must not forget which car this is");
  assert.equal(back.yourRate, null, "and the per-stop values still don't persist");
  assert.equal(back.startPct, 0, "including where the battery was at this one stop");
  assert.equal(back.targetPct, 100);
});

test("a render pass still carries the live percentages in memory, where the sliders read them", () => {
  // The half of persistableFrom that is NOT about storage. Changing units or
  // currency re-runs writeDisplayValues, which rehydrates both sliders from
  // prefs, so dropping these from the fold would snap a user's 20/90 back to
  // 0/100 mid-session. Not persisted and not forgotten are different things.
  const prefs = persistableFrom(defaultPrefs(), liveModel());
  assert.equal(prefs.startPct, 20);
  assert.equal(prefs.targetPct, 90);
});

test("the saved outlet power survives a slow car, a render, and the next car", () => {
  // The whole ratchet loop the app actually runs: pick a car, render (which
  // persists), pick another. A cap applied anywhere on that path sticks in
  // storage and outlives the car that caused it.
  savePrefs(applyCarSelection({ ...defaultPrefs(), powerKw: 6.6 }, SLOW_CAR));

  const typed = loadPrefs().powerKw;
  assert.equal(chargeDrawKw(typed, SLOW_CAR), 3.3, "the car is still capped where it matters");
  savePrefs(persistableFrom(loadPrefs(), liveModel({ powerKw: typed })));

  savePrefs(applyCarSelection(loadPrefs(), FAST_CAR));
  assert.equal(loadPrefs().powerKw, 6.6, "a Level 2 outlet is not downgraded by one 3.3 kW car");
});

test("persistableFrom does not mutate the prefs it was given", () => {
  const before = { ...defaultPrefs(), powerKw: 6.6 };
  const after = persistableFrom(before, liveModel({ powerKw: 1.4 }));
  assert.equal(before.powerKw, 6.6, "the caller's prefs are untouched");
  assert.equal(after.powerKw, 1.4);
});

// --- resetPrefs: "Reset everything" really has to reach everything ---

test("resetting forgets the stored setup", () => {
  savePrefs({ ...DEFAULT_PREFS, carId: "honda-clarity", mpg: 42, gasPrice: 3.899, powerKw: 3.3 });
  const out = resetPrefs();
  assert.equal(out.carId, null);
  assert.equal(out.mpg, null);
  assert.equal(out.gasPrice, null);
  assert.equal(out.powerKw, 6.6, "back to the default outlet");
  assert.equal(loadPrefs().carId, null, "and the store agrees, so a reload stays reset");
});

test("resetting twice never hands back the first session's car overrides", () => {
  // Reset has to build a genuinely fresh object. Spreading DEFAULT_PREFS shares
  // its carOverrides, so a caller writing into the prefs it was just handed is
  // writing into the defaults, and the next "Reset everything" gives the user
  // their old car straight back. The write below is in place on purpose: that's
  // what the app did before the overrides moved behind applyCarEdit, and it's
  // what the next caller to reach for prefs.carOverrides will do.
  const first = resetPrefs();
  first.carOverrides["honda-clarity"] = { mpg: 42 };
  savePrefs(first);
  assert.equal(loadPrefs().carOverrides["honda-clarity"].mpg, 42, "saved, as the app would");

  const second = resetPrefs();
  assert.deepEqual(second.carOverrides, {}, "a reset hands back a clean slate");
  assert.deepEqual(loadPrefs().carOverrides, {}, "and clears what was stored");
  assert.deepEqual(DEFAULT_PREFS.carOverrides, {}, "without ever writing into the defaults");
});

test("resetting still works when storage is unavailable", () => {
  delete globalThis.localStorage;
  let out;
  assert.doesNotThrow(() => { out = resetPrefs(); });
  assert.equal(out.carId, null);
  assert.deepEqual(out.carOverrides, {});
});
