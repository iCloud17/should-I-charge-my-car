// storage.test.mjs - assertions for prefs persistence and the per-car override merge.
// Run with:  node --test
// No framework, no dependencies (uses the built-in node:test runner).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadPrefs, savePrefs, mergeCarOverride, defaultPrefs, DEFAULT_PREFS } from "../js/storage.js";

const KEY = "sicc.prefs.v1";

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

test("mergeCarOverride keeps the saved value when the new one isn't a finite number", () => {
  const existing = { mpg: 25, miPerKwh: 2.4, batteryKwh: 20 };
  for (const bad of [NaN, null, undefined, "31", Infinity, -Infinity, {}, true]) {
    const out = mergeCarOverride(existing, { ...existing, mpg: bad });
    assert.equal(out.mpg, 25, `${String(bad)} must not overwrite a saved value`);
  }
});

test("mergeCarOverride accepts a finite incoming value, including zero", () => {
  assert.equal(mergeCarOverride({ mpg: 25 }, { mpg: 31.5 }).mpg, 31.5);
  assert.equal(mergeCarOverride({ mpg: 25 }, { mpg: 0 }).mpg, 0);
  assert.equal(mergeCarOverride({ mpg: 25 }, { mpg: -3 }).mpg, -3);
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

test("mergeCarOverride carries the legacy per-car powerKw through untouched", () => {
  // The rollback contract: existing carOverrides[*].powerKw is kept as inert
  // data. The write path never sends powerKw, so the only thing preserving it
  // is that it's still in OVERRIDE_KEYS and falls through to the saved value.
  // Narrow OVERRIDE_KEYS to the three live fields and the first edit to ANY
  // field on a car silently deletes its rollback data - with a green suite.
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

// --- round trip and persistence contract ---

test("savePrefs and loadPrefs round trip the stable fields", () => {
  savePrefs({
    ...DEFAULT_PREFS,
    carId: "honda-clarity", customName: "Nellie", mpg: 42, miPerKwh: 3.1,
    batteryKwh: 17, gasPrice: 3.899, units: "uk", currency: "£",
    powerKw: 3.3, startPct: 20, targetPct: 80, themeMode: "dark",
    carOverrides: { "honda-clarity": { mpg: 42 } },
  });
  const out = loadPrefs();
  assert.equal(out.carId, "honda-clarity");
  assert.equal(out.customName, "Nellie");
  assert.equal(out.gasPrice, 3.899); // not rounded away
  assert.equal(out.units, "uk");
  assert.equal(out.currency, "£");
  assert.equal(out.powerKw, 3.3);
  assert.equal(out.startPct, 20);
  assert.equal(out.themeMode, "dark");
  assert.deepEqual(out.carOverrides, { "honda-clarity": { mpg: 42 } });
});

test("savePrefs writes only the stable keys, not the per-stop ones", () => {
  const store = seed();
  savePrefs({ ...DEFAULT_PREFS, mpg: 25, yourRate: 0.32, sessionFee: 2.5 });
  const saved = JSON.parse(store.map.get(KEY));
  assert.equal(saved.mpg, 25);
  assert.equal("yourRate" in saved, false);
  assert.equal("sessionFee" in saved, false);
  assert.equal(loadPrefs().yourRate, null); // comes back as the default, not 0.32
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
