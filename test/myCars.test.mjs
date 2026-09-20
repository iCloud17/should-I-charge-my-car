// myCars.test.mjs - assertions for the saved-cars store: sanitization on the
// way back in, the round trip, and the cap.
// Run with:  node --test
// No framework, no dependencies (uses the built-in node:test runner).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  loadMyCars, saveMyCars, clearMyCars, emptyCarsState,
  sanitizeCarsPayload, payloadVersion, cleanName,
  migrateCars, migrateIfNeeded, CUSTOM_CAR_ID,
  addMyCar, removeMyCar, setActiveMyCar, newMyCarId,
  reconcileMyCars, refreshMyCars,
  savedCarCeilingKw, savedCarNumbers, savedCarDraft,
  activeMyCar, findMyCarByCarId, applyMyCarEdit, renameMyCar,
  CARS_V, MAX_MY_CARS,
} from "../js/myCars.js";
import { defaultPrefs, applyCarSelection, applyCarEdit, CAR_EDIT_FIELDS, MAX_CUSTOM_NAME_LEN, MAX_STORED_NUMBER } from "../js/storage.js";
import { carCeilingKw } from "../js/cars.js";

const CARS_KEY = "sicc.cars.v1";
const PREFS_KEY = "sicc.prefs.v1";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

// Install a store holding `raw` under the saved-cars key, as if a previous
// session (or a tamperer) had written it.
function seed(raw) {
  globalThis.localStorage = fakeStorage(raw === undefined ? {} : { [CARS_KEY]: raw });
  return globalThis.localStorage;
}

function car(over = {}) {
  return { id: "c1", carId: "volt-2018", label: "2018 Chevrolet Volt", name: "", mpg: 42, miPerKwh: 3.4, batteryKwh: 18.4, ...over };
}

beforeEach(() => { seed(); });

// --- The shape --------------------------------------------------------------

test("an empty store loads as zero cars and no selection, not a phantom car", () => {
  const state = loadMyCars();
  assert.deepEqual(state.cars, []);
  assert.equal(state.activeId, null);
  assert.equal(state.v, CARS_V);
  assert.equal(state.readOnly, false);
});

test("a valid payload round trips byte-identically", () => {
  const state = { v: CARS_V, cars: [car(), car({ id: "c2", name: "Spare" })], activeId: "c2" };
  seed();
  assert.equal(saveMyCars(state).ok, true);
  const written = globalThis.localStorage.getItem(CARS_KEY);

  // Load it back, save it again, and the stored string must not have moved. A
  // store that rewrites itself on every load is a store that can drift.
  const back = loadMyCars();
  assert.deepEqual(back.cars, state.cars);
  assert.equal(back.activeId, "c2");
  assert.equal(saveMyCars(back).ok, true);
  assert.equal(globalThis.localStorage.getItem(CARS_KEY), written, "a load-save cycle must not change one byte");
});

test("two saved cars may share a carId, which is the entire point", () => {
  const state = { v: CARS_V, cars: [car({ id: "c1", name: "Mine" }), car({ id: "c2", name: "Hers" })], activeId: "c1" };
  const out = sanitizeCarsPayload(state);
  assert.equal(out.cars.length, 2, "same carId, two cars, both kept");
  assert.equal(out.cars[0].carId, out.cars[1].carId);
  assert.notEqual(out.cars[0].id, out.cars[1].id);
});

// --- Tamper cases -----------------------------------------------------------

test("the loader never throws, whatever is in the store", () => {
  for (const junk of ["{", "null", "[]", '"a string"', "42", '{"cars":"not an array"}', '{"cars":{"0":{}}}']) {
    seed(junk);
    const state = loadMyCars();
    assert.ok(Array.isArray(state.cars), `${junk} must load as a state, not a throw`);
    assert.equal(state.activeId, state.activeId === null ? null : state.activeId);
  }
});

test("cars that is not an array becomes an empty list", () => {
  for (const bad of [undefined, null, "x", 3, {}, { 0: car() }]) {
    assert.deepEqual(sanitizeCarsPayload({ v: 1, cars: bad }).cars, [], `${JSON.stringify(bad)} is not a list of cars`);
  }
});

test("one bad car is dropped and the rest are kept", () => {
  const out = sanitizeCarsPayload({
    v: 1,
    cars: [car({ id: "c1" }), null, "nope", car({ id: "c2" }), { id: "c3" }, car({ id: "c4" })],
    activeId: "c4",
  });
  assert.deepEqual(out.cars.map((c) => c.id), ["c1", "c2", "c4"], "the empty c3 goes, the good ones stay");
  assert.equal(out.activeId, "c4");
});

test("a repeated id is dropped rather than renamed", () => {
  const out = sanitizeCarsPayload({
    v: 1,
    cars: [car({ id: "c1", name: "First" }), car({ id: "c1", name: "Impostor" }), car({ id: "c2" })],
    activeId: "c1",
  });
  assert.deepEqual(out.cars.map((c) => c.id), ["c1", "c2"]);
  assert.equal(out.cars[0].name, "First", "the first one wins, the shadow is unreachable anyway");
});

test("an id outside the charset is refused, including __proto__", () => {
  for (const bad of ["__proto__", "constructor", "prototype", "c 1", "C1", "c-1", "c_1", "", "a".repeat(33), 1, null, {}]) {
    const out = sanitizeCarsPayload({ v: 1, cars: [car({ id: bad })], activeId: null });
    assert.deepEqual(out.cars, [], `${String(bad)} must not survive as an id`);
  }
  // And the object built from a payload is a plain one, unreparented.
  const out = sanitizeCarsPayload({ v: 1, cars: [car({ id: "__proto__", mpg: 99 })] });
  assert.equal(Object.getPrototypeOf(out.cars), Array.prototype);
  assert.equal({}.mpg, undefined, "nothing reached Object.prototype");
});

test("a record whose carId does not survive narrowing goes with it", () => {
  // L-3. The carId used to be narrowed to null and the record kept on the
  // strength of its numbers, which left a car nothing on screen could reach:
  // the tile said "Select your car", the search box was empty and both list
  // controls were hidden, while the chip row still showed it checked. Tapping
  // that chip set prefs.carId to the custom sentinel while the record kept
  // carId null, so activeSavedCar could never match again and the car could
  // only be cleared with "Reset everything".
  for (const bad of ["__proto__", "constructor", "prototype", "", undefined, null, 42, {}, "\u0000\u0001"]) {
    const out = sanitizeCarsPayload({ v: 1, cars: [car({ carId: bad })], activeId: "c1" });
    assert.deepEqual(out.cars, [], `${String(bad)} must not leave an unaddressable record`);
    assert.equal(out.activeId, null, "and nothing is left selected");
  }
  // And nothing was reparented on the way past.
  const out = sanitizeCarsPayload({ v: 1, cars: [car({ carId: "__proto__", mpg: 99 })] });
  assert.deepEqual(out.cars, []);
  assert.equal({}.mpg, undefined, "nothing reached Object.prototype");
});

test("the custom car's sentinel is a legitimate carId, not a failed one", () => {
  // The distinction the rule above turns on. __custom__ is the app's own
  // pointer for a car with no dataset row, and it passes safeCarId, so it must
  // keep loading exactly as it did.
  const out = sanitizeCarsPayload({
    v: 1,
    cars: [car({ id: "c1", carId: CUSTOM_CAR_ID, label: "", name: "Van" }), car({ id: "c2", carId: "__proto__" })],
    activeId: "c1",
  });
  assert.deepEqual(out.cars.map((c) => c.carId), [CUSTOM_CAR_ID], "the custom car stays, the unreachable one goes");
  assert.equal(out.cars[0].name, "Van");
  assert.equal(out.cars[0].mpg, 42, "with the numbers the user typed into it");
  assert.equal(out.activeId, "c1", "and the selection still points at it");
});

test("a legitimate car in the same payload as an unaddressable one survives", () => {
  const out = sanitizeCarsPayload({
    v: 1,
    cars: [car({ id: "c1", carId: "__proto__", mpg: 39 }), car({ id: "c2", carId: "volt-2019" })],
    activeId: "c1",
  });
  assert.deepEqual(out.cars.map((c) => c.id), ["c2"], "one tampered entry does not cost the others");
  assert.equal(out.activeId, "c2", "and a selection pointing at the dropped one re-points");
});

test("numbers go through the same positive rule as every other copy of them", () => {
  for (const bad of [0, -3, NaN, Infinity, -Infinity, "42", null, {}, true, MAX_STORED_NUMBER + 1, 1e308]) {
    const out = sanitizeCarsPayload({ v: 1, cars: [car({ mpg: bad })], activeId: "c1" });
    assert.equal(out.cars[0].mpg, undefined, `${String(bad)} is not a saved mpg`);
    assert.equal(out.cars[0].miPerKwh, 3.4, "and the fields beside it are untouched");
  }
  assert.equal(
    sanitizeCarsPayload({ v: 1, cars: [car({ mpg: MAX_STORED_NUMBER })] }).cars[0].mpg,
    MAX_STORED_NUMBER,
    "the bound itself is still a number",
  );
});

test("a battery past the bound is dropped rather than clamped, so no field renders Infinity", () => {
  // L-2. positiveNumber accepted 1e308 because it was finite, and the 2 dp
  // display rounding then overflowed into the literal word Infinity.
  const out = sanitizeCarsPayload({ v: 1, cars: [car({ batteryKwh: 1e308 })], activeId: "c1" });
  assert.equal(out.cars[0].batteryKwh, undefined, "dropped, not held at a maximum");
  assert.equal(out.cars.length, 1, "and the rest of the car survives it");
  assert.equal(savedCarCeilingKw({ carId: null, maxKw: 1e308 }, () => null), Infinity, "a bogus snapshot is no ceiling");
});

test("a car with no carId describes no car, numbers or not", () => {
  const out = sanitizeCarsPayload({ v: 1, cars: [{ id: "c1", name: "Ghost" }], activeId: "c1" });
  assert.deepEqual(out.cars, []);
  assert.equal(out.activeId, null);
  // Numbers do not rescue it: there is still nothing to select, edit or remove.
  const withNumbers = sanitizeCarsPayload({ v: 1, cars: [{ id: "c1", mpg: 42 }], activeId: "c1" });
  assert.deepEqual(withNumbers.cars, []);
});

test("a car with a carId and no numbers is kept, because it inherits the dataset row", () => {
  const out = sanitizeCarsPayload({ v: 1, cars: [{ id: "c1", carId: "volt-2018" }], activeId: "c1" });
  assert.equal(out.cars.length, 1);
  assert.equal(out.cars[0].mpg, undefined);
});

test("the list is capped on the way out of storage too", () => {
  const many = Array.from({ length: 9 }, (_, i) => car({ id: `c${i + 1}` }));
  const out = sanitizeCarsPayload({ v: 1, cars: many, activeId: "c9" });
  assert.equal(out.cars.length, MAX_MY_CARS, "a hand-edited store walks past the write-side cap");
  assert.deepEqual(out.cars.map((c) => c.id), ["c1", "c2", "c3", "c4", "c5"]);
  assert.equal(out.activeId, "c1", "and a selection that fell off the end re-points deterministically");
});

// --- activeId ---------------------------------------------------------------

test("an activeId that does not resolve falls back to the first car", () => {
  const out = sanitizeCarsPayload({ v: 1, cars: [car({ id: "c1" }), car({ id: "c2" })], activeId: "c9" });
  assert.equal(out.activeId, "c1");
});

test("a null activeId means no car is selected, and survives a round trip", () => {
  // The distinction matters: prefs.carId starts null today and the app renders
  // a clean "pick your car" state. Promoting null to the first car would select
  // a car the user never chose.
  const out = sanitizeCarsPayload({ v: 1, cars: [car({ id: "c1" })], activeId: null });
  assert.equal(out.activeId, null);
  assert.equal(sanitizeCarsPayload({ v: 1, cars: [], activeId: "c1" }).activeId, null, "and with no cars there is nothing to select");
});

// --- The name field ---------------------------------------------------------

test("cleanName strips bidi overrides, which is the one that matters here", () => {
  // These reorder rendered text, so two cars can be made to paint identically
  // while holding different numbers. This feature exists to tell near-identical
  // cars apart.
  for (const ch of ["\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068", "\u2069"]) {
    assert.equal(cleanName(`Out${ch}lander`, 40), "Outlander", `${escape(ch)} must not survive`);
  }
});

test("cleanName strips zero-width and soft hyphen, so two names cannot look equal and compare unequal", () => {
  for (const ch of ["\u200B", "\u200E", "\u200F", "\u2060", "\uFEFF", "\u00AD"]) {
    assert.equal(cleanName(`My${ch}Car`, 40), "MyCar", `${escape(ch)} must not survive`);
  }
  assert.equal(cleanName("\u200B\u202E\uFEFF", 40), "", "a name made only of invisibles collapses to empty, not to whitespace");
});

test("cleanName keeps the two joiners, which carry meaning rather than hiding it", () => {
  // U+200D builds one emoji out of several. Stripped, the family came apart
  // into the people it is made of.
  const family = "\u{1F697}\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u{1F3FD}";
  assert.equal(cleanName(family, 40), family, "the ZWJ sequence was taken apart");

  // U+200C is orthographic in Persian and Arabic. Stripped, this is a
  // different and incorrect spelling of the word.
  const persian = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645";
  assert.equal(cleanName(persian, 40), persian, "the ZWNJ was stripped, which respells the word");

  // The reason the rest of the set is still stripped, next to the two that are
  // not: these reorder what is rendered, and the joiners do not.
  assert.equal(cleanName(`\u202Emy\u200Dcar`, 40), "my\u200Dcar", "a bidi override survived alongside the joiner");
});

test("cleanName NFC normalizes, so one name has one spelling", () => {
  const composed = "Citro\u00ebn";        // e with diaeresis, one code point
  const decomposed = "Citro\u0065\u0308n"; // e + combining diaeresis
  assert.equal(cleanName(decomposed, 40), composed);
  assert.equal(cleanName(decomposed, 40), cleanName(composed, 40));
});

test("cleanName collapses whitespace and strips control characters", () => {
  assert.equal(cleanName("  My   \t Outlander \n ", 40), "My Outlander");
  assert.equal(cleanName("My\u0000Car\u009F", 40), "MyCar");
  assert.equal(cleanName("a\nb", 40), "a b", "a newline becomes a space rather than joining two words");
});

test("cleanName caps length after stripping, so padding cannot push real characters past the cap", () => {
  assert.equal(cleanName(`${" ".repeat(50)}Outlander`, 40), "Outlander");
  assert.equal(cleanName("x".repeat(99), 40).length, 40);
  assert.equal(cleanName(`${"\u200B".repeat(99)}ok`, 40), "ok");
});

test("cleanName refuses anything that is not a string, without throwing", () => {
  for (const bad of [undefined, null, 42, {}, [], true]) assert.equal(cleanName(bad, 40), "");
});

test("__proto__ as a car NAME is just text", () => {
  const out = sanitizeCarsPayload({ v: 1, cars: [car({ name: "__proto__" })], activeId: "c1" });
  assert.equal(out.cars[0].name, "__proto__", "a name is never used as a key, so it needs no guard");
  assert.equal(Object.getPrototypeOf(out.cars[0]), Object.prototype);
  assert.equal({}.mpg, undefined);
});

// --- The in-payload version -------------------------------------------------

test("a payload from a newer build is readable and not writable", () => {
  seed(JSON.stringify({ v: CARS_V + 1, cars: [car()], activeId: "c1", somethingNew: true }));
  const state = loadMyCars();
  assert.equal(state.readOnly, true, "read what you can");
  assert.equal(state.cars.length, 1, "and what it could read, it read");

  const before = globalThis.localStorage.getItem(CARS_KEY);
  assert.deepEqual(saveMyCars(state), { ok: false, reason: "read-only" }, "and do not write");
  assert.equal(globalThis.localStorage.getItem(CARS_KEY), before, "not one byte");
});

test("the version is re-read at write time, not trusted from load time", () => {
  // Another tab running a newer build can write between our load and our save.
  // A flag captured at load would be stale in exactly the case it exists for.
  seed(JSON.stringify({ v: CARS_V, cars: [car()], activeId: "c1" }));
  const state = loadMyCars();
  assert.equal(state.readOnly, false);

  globalThis.localStorage.setItem(CARS_KEY, JSON.stringify({ v: 99, cars: [], activeId: null }));
  assert.deepEqual(saveMyCars(state), { ok: false, reason: "read-only" }, "the newer payload wins even though our load said writable");
});

test("the store says WHICH refusal it hit, because they need different sentences", () => {
  // A blocked store is the browser's doing and the user can go and look at it.
  // A newer build's payload is this build being out of date and comes right on
  // a reload. One boolean made the second read as the first, and the user was
  // sent to their privacy settings for a problem they did not have.
  seed(JSON.stringify({ v: CARS_V + 1, cars: [], activeId: null }));
  const readOnly = saveMyCars(emptyCarsState());

  globalThis.localStorage = {
    getItem() { return null; },
    setItem() { throw new Error("private mode"); },
    removeItem() {},
  };
  const unavailable = saveMyCars(emptyCarsState());

  assert.equal(readOnly.ok, false);
  assert.equal(unavailable.ok, false);
  assert.notEqual(readOnly.reason, unavailable.reason, "two conditions, one word: the caller cannot tell them apart");
});

test("an unparseable store is replaced rather than protected", () => {
  seed("{ not json");
  assert.equal(saveMyCars({ v: CARS_V, cars: [car()], activeId: "c1" }).ok, true);
  assert.equal(JSON.parse(globalThis.localStorage.getItem(CARS_KEY)).cars.length, 1);
});

test("payloadVersion reads only a positive integer", () => {
  for (const bad of [undefined, null, 0, -1, 1.5, "1", NaN, Infinity, {}]) {
    assert.equal(payloadVersion({ v: bad }), 0, `${String(bad)} is not a version`);
  }
  assert.equal(payloadVersion({ v: 1 }), 1);
  assert.equal(payloadVersion(null), 0);
});

// --- Exactly one write, and only to our own key -----------------------------

test("saving writes once, and only to sicc.cars.v1", () => {
  const store = seed();
  let writes = 0;
  const realSet = store.setItem;
  store.setItem = (k, v) => { writes++; assert.equal(k, CARS_KEY); realSet(k, v); };
  saveMyCars({ v: CARS_V, cars: [car(), car({ id: "c2" })], activeId: "c1" });
  assert.equal(writes, 1, "one setItem, never incremental");
});

test("nothing in this module reads or writes sicc.prefs.v1", () => {
  const store = seed();
  store.setItem(PREFS_KEY, '{"carId":"volt-2018","mpg":42}');
  const prefsBefore = store.getItem(PREFS_KEY);

  loadMyCars();
  saveMyCars({ v: CARS_V, cars: [car()], activeId: "c1" });
  clearMyCars();

  assert.equal(store.getItem(PREFS_KEY), prefsBefore, "the rollback data is untouched");
  assert.equal(store.getItem(CARS_KEY), null, "and clearing our key clears only ours");
});

test("a store that throws on every call leaves the app working", () => {
  globalThis.localStorage = {
    getItem() { throw new Error("private mode"); },
    setItem() { throw new Error("private mode"); },
    removeItem() { throw new Error("private mode"); },
  };
  assert.deepEqual(loadMyCars(), { ...emptyCarsState(), readOnly: false });
  assert.deepEqual(saveMyCars({ v: CARS_V, cars: [car()], activeId: "c1" }), { ok: false, reason: "unavailable" });
  assert.doesNotThrow(() => clearMyCars());
});

// --- Migration --------------------------------------------------------------
//
// The riskiest step in the feature. Everything below is a legacy prefs object
// written out by hand, exactly as sicc.prefs.v1 would hold it.

// Two dataset rows, so a label lookup has something to find and a miss has
// something to miss.
const DATASET = {
  "volt-2018": { id: "volt-2018", mpg: 42, miPerKwh: 3.4, batteryKwh: 18.4, chargeKw: 3.6 },
  "prius-2021": { id: "prius-2021", mpg: 54, miPerKwh: 4.0, batteryKwh: 8.8, chargeKw: 3.3 },
};
const labelFor = (id) => ({ "volt-2018": "2018 Chevrolet Volt", "prius-2021": "2021 Toyota Prius Prime" }[id] ?? "");

function legacyPrefs(over = {}) {
  return { ...defaultPrefs(), carId: "volt-2018", mpg: 42, miPerKwh: 3.4, batteryKwh: 18.4, ...over };
}

test("MIGRATION IS LOSSLESS: every saved override survives", () => {
  const prefs = legacyPrefs({
    carId: "volt-2018",
    mpg: 39, miPerKwh: 3.1, batteryKwh: 17,
    carOverrides: {
      "volt-2018": { mpg: 39, miPerKwh: 3.1, batteryKwh: 17 },
      "prius-2021": { mpg: 51, miPerKwh: 3.8, batteryKwh: 8.2 },
    },
  });
  const { payload, dropped } = migrateCars(prefs, labelFor);
  assert.deepEqual(dropped, []);
  assert.equal(payload.cars.length, 2);
  const byCarId = Object.fromEntries(payload.cars.map((c) => [c.carId, c]));
  assert.deepEqual(
    { mpg: byCarId["prius-2021"].mpg, miPerKwh: byCarId["prius-2021"].miPerKwh, batteryKwh: byCarId["prius-2021"].batteryKwh },
    { mpg: 51, miPerKwh: 3.8, batteryKwh: 8.2 },
    "the car that was not selected keeps every number it had",
  );
});

test("ACCEPTANCE: after migration the app would render identically", () => {
  const prefs = legacyPrefs({
    carId: "prius-2021",
    mpg: 51, miPerKwh: 3.8, batteryKwh: 8.2, // what is in the fields right now
    carOverrides: {
      "volt-2018": { mpg: 39, miPerKwh: 3.1, batteryKwh: 17 },
      "prius-2021": { mpg: 51, miPerKwh: 3.8, batteryKwh: 8.2 },
    },
  });
  const { payload } = migrateCars(prefs, labelFor);

  // Same active car.
  const active = payload.cars.find((c) => c.id === payload.activeId);
  assert.equal(active.carId, prefs.carId, "same car selected");
  // Same numbers on screen.
  assert.deepEqual(
    { mpg: active.mpg, miPerKwh: active.miPerKwh, batteryKwh: active.batteryKwh },
    { mpg: prefs.mpg, miPerKwh: prefs.miPerKwh, batteryKwh: prefs.batteryKwh },
  );

  // And switching to the other car would put the same numbers up as today.
  // Measured through the real selection function rather than a restatement of
  // what it is believed to do.
  const other = payload.cars.find((c) => c.carId === "volt-2018");
  const today = applyCarSelection(prefs, DATASET["volt-2018"]);
  assert.deepEqual(
    { mpg: other.mpg, miPerKwh: other.miPerKwh, batteryKwh: other.batteryKwh },
    { mpg: today.mpg, miPerKwh: today.miPerKwh, batteryKwh: today.batteryKwh },
  );
});

test("MIGRATION IS IDEMPOTENT: the output is a fixed point of the read path", () => {
  const prefs = legacyPrefs({
    carOverrides: { "volt-2018": { mpg: 39 }, "prius-2021": { mpg: 51, batteryKwh: 8.2 } },
  });
  const once = migrateCars(prefs, labelFor).payload;
  const twice = migrateCars(prefs, labelFor).payload;
  assert.deepEqual(twice, once, "running it again on the same prefs gives the same answer");

  // The output is written and read back, so the composition is what has to
  // settle. Sanitizing it must change nothing, and sanitizing again must
  // change nothing.
  assert.deepEqual(sanitizeCarsPayload(once), once, "migrate then sanitize is a fixed point");
  assert.deepEqual(sanitizeCarsPayload(sanitizeCarsPayload(once)), once);
  assert.equal(JSON.stringify(sanitizeCarsPayload(once)), JSON.stringify(once), "down to key order");
});

test("ORDERING is deterministic and does not depend on insertion order", () => {
  const forward = { "a-car": { mpg: 1 }, "b-car": { mpg: 2 }, "c-car": { mpg: 3 } };
  const backward = { "c-car": { mpg: 3 }, "b-car": { mpg: 2 }, "a-car": { mpg: 1 } };
  const a = migrateCars(legacyPrefs({ carId: "b-car", mpg: 2, carOverrides: forward }), labelFor).payload;
  const b = migrateCars(legacyPrefs({ carId: "b-car", mpg: 2, carOverrides: backward }), labelFor).payload;
  assert.deepEqual(a, b);
  assert.deepEqual(a.cars.map((c) => c.carId), ["b-car", "a-car", "c-car"], "active first, then ascending");
});

test("an override with no matching active car still becomes a car", () => {
  const prefs = legacyPrefs({ carId: null, mpg: null, miPerKwh: null, batteryKwh: null, carOverrides: { "prius-2021": { mpg: 51 } } });
  const { payload } = migrateCars(prefs, labelFor);
  assert.equal(payload.cars.length, 1);
  assert.equal(payload.cars[0].carId, "prius-2021");
  assert.equal(payload.activeId, null, "and nothing is selected on the user's behalf");
});

test("a carId with no override mints a car from the live top-level numbers", () => {
  // Those are what is on screen and what the user recognises. There is nothing
  // else to take them from.
  const prefs = legacyPrefs({ carId: "volt-2018", mpg: 42, miPerKwh: 3.4, batteryKwh: 18.4, carOverrides: {} });
  const { payload } = migrateCars(prefs, labelFor);
  assert.equal(payload.cars.length, 1);
  assert.deepEqual(payload.cars[0], {
    id: "c1", carId: "volt-2018", label: "2018 Chevrolet Volt", name: "",
    mpg: 42, miPerKwh: 3.4, batteryKwh: 18.4,
  });
  assert.equal(payload.activeId, "c1");
});

test("the custom car becomes a normal car, and customName lands in name", () => {
  const prefs = legacyPrefs({
    carId: CUSTOM_CAR_ID, customName: "The van",
    mpg: 22, miPerKwh: 2.1, batteryKwh: 14,
    carOverrides: { [CUSTOM_CAR_ID]: { mpg: 22, miPerKwh: 2.1, batteryKwh: 14 } },
  });
  const { payload } = migrateCars(prefs, labelFor);
  assert.equal(payload.cars.length, 1);
  assert.equal(payload.cars[0].carId, CUSTOM_CAR_ID, "the sentinel is carried, not resolved");
  assert.equal(payload.cars[0].name, "The van");
  assert.equal(payload.cars[0].label, "", "the dataset has no row for it");
  assert.equal(payload.cars[0].mpg, 22);
});

test("customName never leaks onto a car that is not the custom one", () => {
  const prefs = legacyPrefs({ carId: "volt-2018", customName: "The van", carOverrides: { "prius-2021": { mpg: 51 } } });
  for (const c of migrateCars(prefs, labelFor).payload.cars) assert.equal(c.name, "");
});

test("a hostile customName is narrowed on the way through", () => {
  const prefs = legacyPrefs({
    carId: CUSTOM_CAR_ID, customName: "My\u202ECar\u200B\u0000",
    carOverrides: { [CUSTOM_CAR_ID]: { mpg: 22 } },
  });
  assert.equal(migrateCars(prefs, labelFor).payload.cars[0].name, "MyCar");
});

test("no car and no overrides produces ZERO cars, not a phantom", () => {
  const { payload, dropped } = migrateCars(defaultPrefs(), labelFor);
  assert.deepEqual(payload.cars, []);
  assert.equal(payload.activeId, null);
  assert.deepEqual(dropped, []);
});

test("migrateCars never throws, whatever it is handed", () => {
  for (const bad of [undefined, null, 42, "x", [], {}, { carOverrides: "nope" }, { carId: 7 }, { carOverrides: { a: "nope" } }]) {
    assert.doesNotThrow(() => migrateCars(bad, labelFor), `${JSON.stringify(bad)} must not throw`);
  }
  // A label lookup that throws costs the label, never the numbers.
  const boom = () => { throw new Error("dataset not loaded"); };
  const { payload } = migrateCars(legacyPrefs({ carOverrides: { "volt-2018": { mpg: 39 } } }), boom);
  assert.equal(payload.cars[0].label, "");
  assert.equal(payload.cars[0].mpg, 42);
  // So does a missing one.
  assert.equal(migrateCars(legacyPrefs(), undefined).payload.cars[0].label, "");
});

test("a prototype-polluting override key is skipped by the migration", () => {
  const overrides = JSON.parse('{"__proto__":{"mpg":99},"constructor":{"mpg":98},"prototype":{"mpg":97},"volt-2018":{"mpg":39}}');
  const { payload } = migrateCars(legacyPrefs({ carId: null, mpg: null, miPerKwh: null, batteryKwh: null, carOverrides: overrides }), labelFor);
  assert.deepEqual(payload.cars.map((c) => c.carId), ["volt-2018"]);
  assert.equal({}.mpg, undefined);
});

test("bad numbers in an override do not travel", () => {
  const prefs = legacyPrefs({
    carId: null, mpg: null, miPerKwh: null, batteryKwh: null,
    carOverrides: { "volt-2018": { mpg: -99, miPerKwh: 0, batteryKwh: 17, powerKw: 3.3 } },
  });
  const c = migrateCars(prefs, labelFor).payload.cars[0];
  assert.equal(c.mpg, undefined, "a negative mpg is not a saved number");
  assert.equal(c.miPerKwh, undefined, "and neither is a zero");
  assert.equal(c.batteryKwh, 17, "the good one beside them survives");
  assert.equal(c.powerKw, undefined, "the legacy per-car powerKw conflates car and outlet and is not car data");
});

// --- The cap, and what happens above it -------------------------------------

test("over the cap, the extras are LEFT BEHIND and reported, never silently discarded", () => {
  const carOverrides = {};
  for (const id of ["a", "b", "c", "d", "e", "f", "g"]) carOverrides[id] = { mpg: 30 };
  const prefs = legacyPrefs({ carId: "d", mpg: 30, carOverrides });
  const { payload, dropped } = migrateCars(prefs, labelFor);

  assert.equal(payload.cars.length, MAX_MY_CARS);
  assert.deepEqual(payload.cars.map((c) => c.carId), ["d", "a", "b", "c", "e"], "active first, then ascending");
  assert.deepEqual(dropped, ["f", "g"], "and the caller is told exactly what did not fit");
  assert.equal(payload.activeId, "c1", "the car on screen is never the one that falls off");
});

test("nothing dropped by the cap is actually lost, because carOverrides is untouched", () => {
  const carOverrides = {};
  for (const id of ["a", "b", "c", "d", "e", "f", "g"]) carOverrides[id] = { mpg: 30 };
  const prefs = legacyPrefs({ carId: "d", mpg: 30, carOverrides });
  const before = JSON.stringify(prefs);
  migrateCars(prefs, labelFor);
  assert.equal(JSON.stringify(prefs), before, "the migration does not mutate what it was given");
});

test("the reported overflow is exactly the set of cars that did not make it", () => {
  // The migration has its own cap and the loader has another, and leaning on
  // the loader's looks equivalent right up to the point where an entry is
  // dropped for being junk. Then the loader pulls a later car forward to fill
  // the gap while `dropped` still names it, and the caller tells the user it
  // left behind a car that is sitting in the list.
  const carOverrides = {
    "\u0001": { mpg: -1 }, // carId cleans to empty and no number survives: not a car
    a: { mpg: 30 }, b: { mpg: 30 }, c: { mpg: 30 }, d: { mpg: 30 }, e: { mpg: 30 }, f: { mpg: 30 }, g: { mpg: 30 },
  };
  const { payload, dropped } = migrateCars(legacyPrefs({ carId: "d", mpg: 30, carOverrides }), labelFor);
  const present = new Set(payload.cars.map((c) => c.carId));
  for (const id of dropped) assert.equal(present.has(id), false, `${id} was reported dropped and is in the list`);
  assert.ok(payload.cars.length <= MAX_MY_CARS);
});

// --- The store boundary for migration ---------------------------------------

test("migrateIfNeeded writes exactly once, and only when there is nothing there", () => {
  const store = seed();
  let writes = 0;
  const realSet = store.setItem;
  store.setItem = (k, v) => { writes++; assert.equal(k, CARS_KEY); realSet(k, v); };

  const prefs = legacyPrefs({ carOverrides: { "volt-2018": { mpg: 39 }, "prius-2021": { mpg: 51 } } });
  const first = migrateIfNeeded(prefs, labelFor);
  assert.equal(first.migrated, true);
  assert.equal(first.cars, 2);
  assert.equal(writes, 1, "atomic: built in memory, written once");

  const again = migrateIfNeeded(prefs, labelFor);
  assert.equal(again.migrated, false);
  assert.equal(again.reason, "already-present");
  assert.equal(writes, 1, "and it never runs twice");
});

test("a user who deleted every saved car does not get them resurrected", () => {
  seed();
  const prefs = legacyPrefs({ carOverrides: { "volt-2018": { mpg: 39 } } });
  migrateIfNeeded(prefs, labelFor);
  saveMyCars(emptyCarsState());
  assert.equal(migrateIfNeeded(prefs, labelFor).reason, "already-present");
  assert.deepEqual(loadMyCars().cars, [], "the key's presence is the record that it already ran");
});

test("nothing to migrate is a normal outcome and writes nothing", () => {
  const store = seed();
  const res = migrateIfNeeded(defaultPrefs(), labelFor);
  assert.equal(res.migrated, false);
  assert.equal(res.reason, "nothing-to-migrate");
  assert.equal(store.getItem(CARS_KEY), null, "and the one-shot flag is not burned");
});

test("a migration that cannot be written falls back instead of half-writing", () => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem() { throw new Error("quota"); },
    removeItem() {},
  };
  const res = migrateIfNeeded(legacyPrefs({ carOverrides: { "volt-2018": { mpg: 39 } } }), labelFor);
  assert.equal(res.migrated, false);
  assert.equal(res.reason, "write-refused");
});

test("a store that throws on read fails safe rather than throwing into the app", () => {
  globalThis.localStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() {}, removeItem() {},
  };
  const res = migrateIfNeeded(legacyPrefs(), labelFor);
  assert.equal(res.migrated, false);
  assert.equal(res.reason, "failed");
});

test("migrateIfNeeded refuses to write over a payload from a newer build", () => {
  seed(JSON.stringify({ v: CARS_V + 1, cars: [], activeId: null }));
  const res = migrateIfNeeded(legacyPrefs({ carOverrides: { "volt-2018": { mpg: 39 } } }), labelFor);
  assert.equal(res.migrated, false);
  assert.equal(res.reason, "already-present", "the key is there, so migration is not its business");
  assert.equal(payloadVersion(JSON.parse(globalThis.localStorage.getItem(CARS_KEY))), CARS_V + 1, "untouched");
});

test("migrating does not touch sicc.prefs.v1, which is the rollback", () => {
  const store = seed();
  store.setItem(PREFS_KEY, '{"carId":"volt-2018","carOverrides":{"volt-2018":{"mpg":39}}}');
  const before = store.getItem(PREFS_KEY);
  migrateIfNeeded(legacyPrefs({ carOverrides: { "volt-2018": { mpg: 39 } } }), labelFor);
  assert.equal(store.getItem(PREFS_KEY), before);
});

// --- Adding, removing, selecting --------------------------------------------

const draft = (over = {}) => ({ carId: "volt-2018", label: "2018 Chevrolet Volt", name: "", mpg: 42, miPerKwh: 3.4, batteryKwh: 18.4, ...over });

function fill(n) {
  let state = emptyCarsState();
  for (let i = 0; i < n; i++) state = addMyCar(state, draft({ name: `Car ${i + 1}` })).state;
  return state;
}

test("AT THE CAP addMyCar refuses and says why, it never silently drops", () => {
  const full = fill(MAX_MY_CARS);
  assert.equal(full.cars.length, MAX_MY_CARS);
  const res = addMyCar(full, draft({ name: "One too many" }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "full");
  assert.equal(res.limit, MAX_MY_CARS, "the caller can say the number in the user's terms");
  assert.deepEqual(res.state, full, "and nothing is evicted to make room");
  assert.equal(res.state.cars.length, MAX_MY_CARS);
});

test("a car that describes no car is refused rather than stored empty", () => {
  const res = addMyCar(emptyCarsState(), { name: "Ghost" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "invalid");
  assert.deepEqual(res.state.cars, []);
});

test("the first car added becomes the selected one, and later ones do not steal it", () => {
  const one = addMyCar(emptyCarsState(), draft({ name: "First" })).state;
  assert.equal(one.activeId, one.cars[0].id);
  const two = addMyCar(one, draft({ name: "Second" })).state;
  assert.equal(two.activeId, one.cars[0].id, "a mis-tap must not move the user somewhere they did not ask to go");
});

test("minted ids are unique, constrained, and never collide with a migrated id", () => {
  const state = fill(MAX_MY_CARS);
  const ids = state.cars.map((c) => c.id);
  assert.equal(new Set(ids).size, MAX_MY_CARS, "no duplicates");
  for (const id of ids) {
    assert.match(id, /^[a-z0-9]{1,32}$/, "constrained charset and length");
    assert.ok(id.length > 3, "long enough that it cannot collide with c1 through c5");
  }
  // And a mint against ids already in hand never returns one of them.
  assert.equal(ids.includes(newMyCarId(ids)), false);
  assert.match(newMyCarId([]), /^[a-z0-9]{1,32}$/);
  assert.match(newMyCarId(null), /^[a-z0-9]{1,32}$/);
});

test("a minted id survives a save and load round trip", () => {
  seed();
  const state = fill(3);
  assert.equal(saveMyCars(state).ok, true);
  assert.deepEqual(loadMyCars().cars.map((c) => c.id), state.cars.map((c) => c.id));
});

test("minted ids stay distinct with the clock and the random source held still", () => {
  // Uniqueness here has to be structural, not statistical. Five cars against a
  // 46656-value draw makes a real collision too rare for a test to provoke, so
  // the sources are pinned and the loop is left as the only thing separating
  // one id from the next.
  const realNow = Date.now;
  const realRandom = Math.random;
  try {
    Date.now = () => 1700000000000;
    Math.random = () => 0.5;
    const ids = [];
    for (let i = 0; i < MAX_MY_CARS; i++) ids.push(newMyCarId(ids));
    assert.equal(new Set(ids).size, MAX_MY_CARS, "same millisecond, same draw, still five distinct ids");
    for (const id of ids) assert.match(id, /^[a-z0-9]{1,32}$/, "and each one still inside the charset");
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
});

test("removing the selected car selects the one BEFORE it, the way a tab bar does", () => {
  // Deleting the last chip used to jump the user back to the first car, which
  // is the far end of the row from where they were looking.
  const state = fill(3);
  const [a, b, c] = state.cars;
  const onC = setActiveMyCar(state, c.id).state;
  const res = removeMyCar(onC, c.id);
  assert.equal(res.ok, true);
  assert.deepEqual(res.state.cars.map((x) => x.name), [a.name, b.name]);
  assert.equal(res.state.activeId, b.id, "B, not A");

  // And again from there: removing B lands on A.
  assert.equal(removeMyCar(res.state, res.state.cars[1].id).state.activeId, res.state.cars[0].id);
});

test("removing the selected middle car selects its predecessor", () => {
  const state = fill(3);
  const onB = setActiveMyCar(state, state.cars[1].id).state;
  const res = removeMyCar(onB, state.cars[1].id);
  assert.equal(res.state.activeId, res.state.cars[0].id, "A");
  assert.equal(res.state.cars[0].name, "Car 1");
});

test("removing the selected FIRST car selects the new first car", () => {
  // There is no car before the head, so the neighbour is the one that takes its
  // place. max(0, removedIndex - 1) is what says so.
  const state = fill(3);
  const onA = setActiveMyCar(state, state.cars[0].id).state;
  const res = removeMyCar(onA, state.cars[0].id);
  assert.equal(res.state.activeId, res.state.cars[0].id);
  assert.equal(res.state.cars[0].name, "Car 2", "B");
});

test("removing a car that is NOT the selected one leaves the selection alone", () => {
  // The selection only moves when the car under it goes. Removing from either
  // side of the selected car is not an invitation to move the user.
  const state = fill(3);
  const onB = setActiveMyCar(state, state.cars[1].id).state;
  assert.equal(removeMyCar(onB, state.cars[2].id).state.activeId, state.cars[1].id, "removing C after it");
  assert.equal(removeMyCar(onB, state.cars[0].id).state.activeId, state.cars[1].id, "removing A before it");
});

test("a removal that finds an already-dangling selection still falls back to the first car", () => {
  // The loader's rule, untouched: a pointer that resolves to nothing is broken
  // rather than chosen, and there is no neighbour to a car that is not there.
  const state = { ...fill(3), activeId: "gone" };
  const res = removeMyCar(state, state.cars[2].id);
  assert.equal(res.state.activeId, res.state.cars[0].id);
});

test("removing the last car leaves no selection rather than a dangling one", () => {
  const one = fill(1);
  const res = removeMyCar(one, one.cars[0].id);
  assert.deepEqual(res.state.cars, []);
  assert.equal(res.state.activeId, null);
});

test("removing something that is not there changes nothing", () => {
  const state = fill(2);
  const res = removeMyCar(state, "nope");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not-found");
  assert.deepEqual(res.state, state);
});

test("removing frees a slot at the cap, so the refusal is not a dead end", () => {
  const full = fill(MAX_MY_CARS);
  assert.equal(addMyCar(full, draft()).ok, false);
  const freed = removeMyCar(full, full.cars[0].id).state;
  assert.equal(addMyCar(freed, draft({ name: "Replacement" })).ok, true);
});

test("setActiveMyCar selects a real car, refuses one that is not there, and allows deselecting", () => {
  const state = fill(2);
  assert.equal(setActiveMyCar(state, state.cars[1].id).state.activeId, state.cars[1].id);
  const miss = setActiveMyCar(state, "nope");
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, "not-found");
  assert.deepEqual(miss.state, state);
  assert.equal(setActiveMyCar(state, null).state.activeId, null, "no car chosen is a real state");
});

test("the list operations never mutate the state they were given", () => {
  const state = fill(2);
  const snapshot = JSON.stringify(state);
  addMyCar(state, draft({ name: "Third" }));
  removeMyCar(state, state.cars[0].id);
  setActiveMyCar(state, state.cars[1].id);
  addMyCar(fill(MAX_MY_CARS), draft());
  assert.equal(JSON.stringify(state), snapshot);
});

test("the list operations tolerate a state that is not one", () => {
  for (const bad of [undefined, null, 42, "x", {}, { cars: "nope" }]) {
    assert.doesNotThrow(() => addMyCar(bad, draft()), `add: ${JSON.stringify(bad)}`);
    assert.doesNotThrow(() => removeMyCar(bad, "c1"), `remove: ${JSON.stringify(bad)}`);
    assert.doesNotThrow(() => setActiveMyCar(bad, null), `select: ${JSON.stringify(bad)}`);
  }
  assert.equal(addMyCar(null, draft()).state.cars.length, 1);
});

test("a hostile name added through the API is narrowed, not stored raw", () => {
  const res = addMyCar(emptyCarsState(), draft({ name: "  My\u202EOut\u200Blander\u0000  " }));
  assert.equal(res.state.cars[0].name, "MyOutlander");
});

test("the cap holds through save and load, so a full list stays a full list", () => {
  seed();
  const full = fill(MAX_MY_CARS);
  saveMyCars(full);
  const back = loadMyCars();
  assert.equal(back.cars.length, MAX_MY_CARS);
  assert.equal(addMyCar(back, draft()).reason, "full");
});

// --- Re-reading a store another tab has written -----------------------------
//
// The defect these hold: every tab keeps the whole list in memory and
// saveMyCars writes all of it, so a tab that has not looked at the disk since
// another tab wrote to it saves that other tab's cars away on its next
// ordinary act. The payload cannot defend itself; the stale tab has to read
// again, and reconcileMyCars is the rule for what it does with what it finds.

test("a refresh takes the DISK's list, so a car another tab added arrives", () => {
  const mine = fill(2);
  const theirs = addMyCar(mine, draft({ name: "Weekend" })).state;
  const next = reconcileMyCars(theirs, mine.activeId);
  assert.deepEqual(next.cars.map((c) => c.name), ["Car 1", "Car 2", "Weekend"]);
  assert.equal(next.activeId, mine.activeId, "and my selection is still mine");
});

test("a car another tab REMOVED does not come back", () => {
  const mine = fill(3);
  const theirs = removeMyCar(mine, mine.cars[2].id).state;
  const next = reconcileMyCars(theirs, mine.activeId);
  assert.equal(next.cars.length, 2, "a merge here would resurrect a deliberate deletion");
  assert.equal(next.cars.some((c) => c.id === mine.cars[2].id), false);
});

test("the disk's own activeId is ignored: the selection belongs to this tab", () => {
  // The selection is what THIS tab's screen is showing. Another tab switching
  // chips must not move it, or a background tab drags the foreground one to a
  // car nobody asked for.
  const mine = fill(3);
  const theirs = setActiveMyCar(mine, mine.cars[2].id).state;
  assert.equal(reconcileMyCars(theirs, mine.cars[0].id).activeId, mine.cars[0].id);
});

test("a selection another tab removed DESELECTS rather than pointing at a different car", () => {
  // Where this parts company with the loader's rule. resolveActiveId repairs a
  // dangling pointer found on disk by falling back to the first car, which is
  // right at load time and wrong here: promoting a car would check a chip for a
  // car that is not the one on screen, and the open remove question would go on
  // to name it.
  const mine = fill(3);
  const wanted = mine.cars[1].id;
  const theirs = removeMyCar(setActiveMyCar(mine, wanted).state, wanted).state;
  assert.notEqual(theirs.activeId, null, "the OTHER tab did pick a successor for itself");
  assert.equal(reconcileMyCars(theirs, wanted).activeId, null, "but this tab must not inherit it");
});

test("no selection stays no selection, even once another tab has saved a car", () => {
  const theirs = fill(1);
  assert.equal(reconcileMyCars(theirs, null).activeId, null);
  assert.equal(reconcileMyCars(theirs, undefined).activeId, null);
});

test("an emptied store leaves nothing selected rather than throwing", () => {
  assert.deepEqual(reconcileMyCars(emptyCarsState(), "c1"), { v: CARS_V, cars: [], activeId: null });
  for (const bad of [undefined, null, 42, "x", {}, { cars: "nope" }]) {
    assert.deepEqual(reconcileMyCars(bad, "c1"), { v: CARS_V, cars: [], activeId: null }, `disk: ${JSON.stringify(bad)}`);
  }
});

test("a refresh never mutates the state it was handed", () => {
  const theirs = fill(2);
  const snapshot = JSON.stringify(theirs);
  reconcileMyCars(theirs, theirs.cars[0].id);
  assert.equal(JSON.stringify(theirs), snapshot);
});

test("refreshMyCars reads the store and WRITES NOTHING", () => {
  // The contract, not a detail. A refresh that wrote would fire a storage event
  // in the tab it was refreshing from, and two tabs answering each other's
  // writes never stop.
  const store = seed();
  saveMyCars(fill(2));
  const before = store.getItem(CARS_KEY);
  let writes = 0;
  store.setItem = () => { writes += 1; };
  store.removeItem = () => { writes += 1; };

  const back = refreshMyCars(null);
  assert.equal(writes, 0, "the refresh path wrote to storage");
  assert.equal(store.map.get(CARS_KEY), before, "and the payload is byte-identical");
  assert.deepEqual(back.cars.map((c) => c.name), ["Car 1", "Car 2"]);
});

test("refreshMyCars keeps the read-only flag, so a newer build's payload stays unwritable", () => {
  seed(JSON.stringify({ v: CARS_V + 1, cars: [{ id: "c1", carId: "volt-2018" }], activeId: "c1" }));
  const back = refreshMyCars("c1");
  assert.equal(back.readOnly, true);
  assert.equal(back.activeId, "c1");
});

test("a refresh survives a store that throws on every call", () => {
  globalThis.localStorage = {
    getItem() { throw new Error("nope"); },
    setItem() { throw new Error("nope"); },
    removeItem() { throw new Error("nope"); },
  };
  assert.doesNotThrow(() => refreshMyCars("c1"));
  assert.deepEqual(refreshMyCars("c1").cars, []);
});

// --- The onboard maximum: snapshot in, live dataset out ---------------------
//
// maxKw exists for the orphaned car. A reseed changes a carId, the lookup stops
// resolving, and without a snapshot the ceiling is Infinity: the car keeps its
// numbers and its name and silently loses its charge-rate cap, so MAX_OUTLET_KW
// is the only bound left and the time estimate comes out optimistic. That is
// the same premise that already justifies snapshotting the label, applied to
// the field where being wrong costs an answer rather than a caption.
//
// It is NOT the outlet, and the last two tests in this section are the ones
// that matter most, because the conflated ancestor of this field is where three
// of this week's defects came from.

const getCar = (id) => DATASET[id] ?? null;

test("the snapshot is taken from the dataset when a car is ADDED", () => {
  seed();
  const res = addMyCar(emptyCarsState(), draft({ carId: "volt-2018" }), getCar);
  assert.equal(res.ok, true);
  assert.equal(res.state.cars[0].maxKw, 3.6, "the dataset's chargeKw, copied at save time");

  saveMyCars(res.state);
  assert.equal(loadMyCars().cars[0].maxKw, 3.6, "and it survives the round trip");

  // Looked up by the id the record actually STORES, not by the raw one the
  // caller sent. A draft whose carId only differs by what the sanitizer strips
  // is the same car, and it must not miss the dataset and come back uncapped.
  const padded = addMyCar(emptyCarsState(), draft({ carId: " volt-2018 " }), getCar).state.cars[0];
  assert.equal(padded.carId, "volt-2018");
  assert.equal(padded.maxKw, 3.6);
});

test("the snapshot is taken from the dataset when a car is MIGRATED", () => {
  const prefs = legacyPrefs({
    carId: "volt-2018",
    carOverrides: { "volt-2018": { mpg: 39 }, "prius-2021": { mpg: 51 } },
  });
  const byCarId = Object.fromEntries(migrateCars(prefs, labelFor, getCar).payload.cars.map((c) => [c.carId, c]));
  assert.equal(byCarId["volt-2018"].maxKw, 3.6);
  assert.equal(byCarId["prius-2021"].maxKw, 3.3, "every car, not only the selected one");

  // And through the store boundary, which is the only path a real user takes.
  seed();
  assert.equal(migrateIfNeeded(prefs, labelFor, getCar).migrated, true);
  assert.equal(loadMyCars().cars[0].maxKw, 3.6, "the lookup reaches the writer, not just the pure function");
});

test("a car the dataset has no row for gets NO snapshot and stays uncapped", () => {
  // Today's behavior for a custom car, unchanged: there is nothing to take a
  // ceiling from, so MAX_OUTLET_KW remains its only bound.
  const custom = addMyCar(emptyCarsState(), draft({ carId: CUSTOM_CAR_ID, name: "The van" }), getCar).state.cars[0];
  assert.equal("maxKw" in custom, false, "absent, not zero and not invented");
  assert.equal(savedCarCeilingKw(custom, getCar), Infinity);

  const prefs = legacyPrefs({ carId: CUSTOM_CAR_ID, carOverrides: { [CUSTOM_CAR_ID]: { mpg: 22 } } });
  assert.equal("maxKw" in migrateCars(prefs, labelFor, getCar).payload.cars[0], false, "and the same at migration");
});

test("an unresolvable carId falls back to the snapshot, which is the whole point", () => {
  // scripts/seed.mjs renamed the row out from under a saved car. The numbers
  // and the name survive today; without maxKw the ceiling would not, and the
  // estimate would quietly get faster.
  const orphan = { id: "c1", carId: "volt-2017", mpg: 42, maxKw: 3.6 };
  assert.equal(savedCarCeilingKw(orphan, getCar), 3.6);
  assert.equal(savedCarCeilingKw({ ...orphan, maxKw: undefined }, getCar), Infinity, "and with no snapshot it is the cap that is lost");
});

test("THE LIVE DATASET WINS over a stale snapshot, in both directions", () => {
  // A reseed that corrects a chargeKw has to take effect, so the snapshot is a
  // fallback and never a cache of a number that has moved on.
  assert.equal(savedCarCeilingKw({ carId: "volt-2018", maxKw: 99 }, getCar), 3.6, "a snapshot above the live figure does not raise it");
  assert.equal(savedCarCeilingKw({ carId: "volt-2018", maxKw: 1.1 }, getCar), 3.6, "and one below it does not lower it");
  // Measured against the real dataset rule rather than a restatement of it.
  assert.equal(savedCarCeilingKw({ carId: "volt-2018", maxKw: 99 }, getCar), carCeilingKw(DATASET["volt-2018"]));

  // A reseed that raises the figure reaches the saved car too.
  const reseeded = (id) => (id === "volt-2018" ? { ...DATASET[id], chargeKw: 7.4 } : null);
  assert.equal(savedCarCeilingKw({ carId: "volt-2018", maxKw: 3.6 }, reseeded), 7.4);
});

test("a row that resolves and carries no figure answers for itself", () => {
  // The lookup did not fail, so there is nothing to fall back to. The dataset
  // now says it has no figure for this car, and a snapshot that overrode that
  // would be exactly the cache this is not allowed to be.
  const noFigure = (id) => (id === "volt-2018" ? { id, mpg: 42 } : null);
  assert.equal(savedCarCeilingKw({ carId: "volt-2018", maxKw: 3.6 }, noFigure), Infinity);
});

test("a tampered snapshot goes through the same positive rule as every other number", () => {
  for (const bad of [0, -3, NaN, Infinity, -Infinity, "3.6", null, {}, true]) {
    const out = sanitizeCarsPayload({ v: 1, cars: [car({ maxKw: bad })], activeId: "c1" });
    assert.equal(out.cars[0].maxKw, undefined, `${String(bad)} is not a saved ceiling`);
    assert.equal(out.cars[0].mpg, 42, "and the fields beside it are untouched");
  }
  assert.equal(sanitizeCarsPayload({ v: 1, cars: [car({ maxKw: 3.6 })] }).cars[0].maxKw, 3.6, "a real one survives");
  // On its own it describes no car: there is nothing to apply it to.
  assert.deepEqual(sanitizeCarsPayload({ v: 1, cars: [{ id: "c1", maxKw: 3.6 }] }).cars, []);
});

test("savedCarCeilingKw re-checks the stored field rather than trusting it", () => {
  // It can be handed a record that did not come through the loader.
  for (const bad of [0, -3, NaN, Infinity, "3.6", null, {}]) {
    assert.equal(savedCarCeilingKw({ carId: "gone-2019", maxKw: bad }, getCar), Infinity, `${String(bad)} is not a ceiling`);
  }
  assert.equal(savedCarCeilingKw(null, getCar), Infinity, "and no car at all is not a throw");
  assert.equal(savedCarCeilingKw({ carId: "volt-2018" }), Infinity, "nor is a missing lookup");
});

test("a car with no dataset pointer is never handed another car's ceiling", () => {
  // carId is null for a saved car whose pointer was rejected on the way in, and
  // for one that never had one. A lookup is not even attempted for it, because
  // a lookup that answers anyway would cap this car at a stranger's figure.
  const answersAnything = () => ({ id: "someone-else", chargeKw: 9.9 });
  assert.equal(savedCarCeilingKw({ carId: null, maxKw: 3.6 }, answersAnything), 3.6);
  assert.equal(savedCarCeilingKw({ carId: "", mpg: 42 }, answersAnything), Infinity);
});

test("a lookup that throws or answers with junk costs the snapshot, never the car", () => {
  const boom = () => { throw new Error("dataset not loaded"); };
  const res = addMyCar(emptyCarsState(), draft({ carId: "volt-2018" }), boom);
  assert.equal(res.ok, true, "the car is still saved");
  assert.equal(res.state.cars[0].maxKw, undefined);
  assert.equal(res.state.cars[0].mpg, 42, "with its numbers intact");
  assert.equal(savedCarCeilingKw({ carId: "volt-2018", maxKw: 3.6 }, boom), 3.6, "and a throwing lookup falls back");

  const { payload } = migrateCars(legacyPrefs({ carOverrides: { "volt-2018": { mpg: 39 } } }), labelFor, boom);
  assert.equal(payload.cars[0].maxKw, undefined);
  assert.equal(payload.cars[0].mpg, 42);

  // A lookup shaped to return the figure rather than the row fails closed,
  // rather than half-working and hiding the mismatch.
  for (const junk of [undefined, null, 3.6, "3.6", true]) {
    assert.equal(addMyCar(emptyCarsState(), draft(), () => junk).state.cars[0].maxKw, undefined, `${String(junk)} is not a dataset row`);
    assert.equal(savedCarCeilingKw({ carId: "volt-2018", maxKw: 3.6 }, () => junk), 3.6, `${String(junk)} must not count as a resolved row`);
  }

  // A row carrying a figure that is not a figure takes no snapshot either. The
  // dataset is bundled and trusted, but a stub, a patch script or a half-built
  // row is not a reason to save a zero as a ceiling.
  for (const bad of [0, -3, NaN, Infinity, "3.6", null]) {
    const got = addMyCar(emptyCarsState(), draft(), () => ({ id: "volt-2018", chargeKw: bad })).state.cars[0].maxKw;
    assert.equal(got, undefined, `${String(bad)} is not a chargeKw worth snapshotting`);
  }
});

test("maxKw is the DATASET's answer whenever the dataset has a row to answer with", () => {
  const base = addMyCar(emptyCarsState(), draft(), getCar).state.cars[0].maxKw;
  assert.equal(base, 3.6);
  for (const noise of [{ powerKw: 9.9 }, { maxKw: 9.9 }, { chargeKw: 9.9 }, { mpg: 9.9 }, { label: "9.9" }, { name: "9.9 kW" }]) {
    const got = addMyCar(emptyCarsState(), draft(noise), getCar).state.cars[0].maxKw;
    assert.equal(got, base, `${JSON.stringify(noise)} moved the ceiling`);
  }
  // A row that resolves and carries no figure still answers for itself: no
  // ceiling is the dataset's answer, not a reason to ask the draft.
  const noFigure = (id) => (id === "volt-2018" ? { id, mpg: 42 } : null);
  assert.equal(addMyCar(emptyCarsState(), draft({ maxKw: 9.9 }), noFigure).state.cars[0].maxKw, undefined);

  // And the one thing that is allowed to move it, does.
  const reseeded = (id) => (id === "volt-2018" ? { ...DATASET[id], chargeKw: 7.4 } : null);
  assert.equal(addMyCar(emptyCarsState(), draft(), reseeded).state.cars[0].maxKw, 7.4);
});

test("COPYING AN ORPHAN KEEPS THE CEILING, because nothing else can supply it", () => {
  // H-4's orphan variant. A reseed dropped the row, so the record's own
  // snapshot is the last thing that knows this car charges at 3.6 kW. The copy
  // used to be created with no ceiling at all, so it estimated faster than the
  // car it was copied from, in the app's own voice, with nothing on screen
  // saying the two differed.
  const orphan = { id: "c1", carId: "gone-2019", label: "2019 Ghost", name: "", mpg: 44, miPerKwh: 3.1, batteryKwh: 12, maxKw: 3.6 };
  assert.equal(savedCarCeilingKw(orphan, getCar), 3.6);

  const copy = addMyCar(emptyCarsState(), { ...savedCarDraft(orphan), carId: orphan.carId, label: orphan.label }, getCar).state.cars[0];
  assert.equal(copy.maxKw, 3.6, "the snapshot survived the copy");
  assert.equal(savedCarCeilingKw(copy, getCar), savedCarCeilingKw(orphan, getCar), "so the copy caps where the original does");

  // And the numbers came too, which for an orphan is the only way it has any:
  // there is no row to inherit from, so a copy with none shows whatever car was
  // on screen before it.
  assert.deepEqual(savedCarNumbers(copy, getCar), { mpg: 44, miPerKwh: 3.1, batteryKwh: 12 });

  // The fallback is narrowed like every other stored number, so a tampered
  // record cannot copy a junk ceiling into a fresh one.
  for (const bad of [0, -3, NaN, Infinity, "3.6", null, {}]) {
    const got = addMyCar(emptyCarsState(), { carId: "gone-2019", mpg: 44, maxKw: bad }, getCar).state.cars[0].maxKw;
    assert.equal(got, undefined, `${String(bad)} is not a ceiling to carry across`);
  }
});

test("NO OUTLET VALUE CAN REACH maxKw, through either writer", () => {
  // The invariant this field exists to keep. Its conflated ancestor, the
  // per-car powerKw an older release wrote into carOverrides, is an OUTLET
  // reading, and reading one back as the car's ceiling is the defect shape the
  // whole separation is for. Every key a caller or a legacy store could carry
  // an outlet in is loaded with one distinctive number, and none of them may
  // appear anywhere in a saved car.
  assert.equal(CAR_EDIT_FIELDS.includes("maxKw"), false, "the loop that copies the editable numbers must not be able to reach it");

  const OUTLET = 7.77;
  const ov = { mpg: 39, powerKw: OUTLET, maxKw: OUTLET, chargeKw: OUTLET };
  const prefs = legacyPrefs({
    carId: "volt-2018", powerKw: OUTLET, maxKw: OUTLET, chargeKw: OUTLET,
    carOverrides: {
      "volt-2018": ov,
      "prius-2021": { ...ov, mpg: 51 },
      // The car a reseed orphaned. It has no row to snapshot from, so the
      // outlet sitting in its own override is the nearest thing to a ceiling
      // and must still not become one.
      "gone-2019": { ...ov, mpg: 44 },
    },
  });
  const { payload } = migrateCars(prefs, labelFor, getCar);
  assert.equal(JSON.stringify(payload).includes(String(OUTLET)), false, "the outlet figure is nowhere in the migrated store");
  for (const c of payload.cars) {
    assert.equal(c.maxKw, DATASET[c.carId]?.chargeKw, `${c.carId} holds something other than the dataset's answer`);
  }

  // The other writer, handed a draft assembled from the edit fields, which is
  // the path an outlet would have to take to get in.
  const added = addMyCar(emptyCarsState(), draft({ powerKw: OUTLET, maxKw: OUTLET, chargeKw: OUTLET }), getCar);
  assert.equal(JSON.stringify(added.state).includes(String(OUTLET)), false);
  assert.equal(added.state.cars[0].maxKw, 3.6, "the dataset wrote it, not the draft");

  // With NO dataset row the draft's own maxKw IS the fallback, so the guard
  // that keeps an outlet out has to be the NAME rather than the absence of a
  // fallback. powerKw is what a legacy override carries, and nothing narrows a
  // powerKw into this key: an override spread into a draft brings the outlet
  // under its own name, where safeCar never looks.
  const legacy = { carId: "gone-2019", mpg: 44, powerKw: OUTLET };
  const fromOverride = addMyCar(emptyCarsState(), legacy, getCar).state.cars[0];
  assert.equal(fromOverride.maxKw, undefined);
  assert.equal(JSON.stringify(fromOverride).includes(String(OUTLET)), false, "the outlet is nowhere in the record");
  assert.equal(savedCarCeilingKw(fromOverride, getCar), Infinity, "uncapped is the honest answer, not 7.77");

  // And the route that DOES carry a maxKw across cannot carry an outlet, because
  // it reads a record, and a record has never held one.
  assert.equal("powerKw" in savedCarDraft({ id: "c1", carId: "gone-2019", powerKw: OUTLET, maxKw: 3.6 }), false);
  assert.deepEqual(savedCarDraft({ id: "c1", carId: "gone-2019", powerKw: OUTLET, maxKw: 3.6 }), { maxKw: 3.6 });
});

test("source guard: the outlet has no name inside the saved-cars module", () => {
  // A source scan, not a behavior test, in the same spirit as the preset guard
  // in cars.test.mjs. The tests above cover every path that exists today; this
  // one is about the path someone adds tomorrow. A failure means "go read the
  // new line", not "a bug is proven". Reformatting these lines will break it;
  // rewrite the guard then.
  const src = readFileSync(new URL("../js/myCars.js", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  assert.doesNotMatch(code, /powerKw/, "the outlet field is named in the module that snapshots the ceiling");

  const reads = code.split("\n").filter((l) => l.includes("chargeKw"));
  assert.deepEqual(reads.map((l) => l.trim()), ["return row ? row.chargeKw : undefined;"], "the dataset figure is read in exactly one place, and that place is the snapshot");

  const defines = code.split("\n").filter((l) => l.includes("raw.maxKw"));
  assert.deepEqual(defines.map((l) => l.trim()), ["const snapshot = positiveNumber(raw.maxKw);"], "the stored field is narrowed in exactly one place");

  const writes = code.split("\n").filter((l) => /maxKw\s*[:=](?!=)/.test(l));
  assert.equal(writes.length, 4, "four writers: the sanitizer, addMyCar, migrateCars, savedCarDraft");
  for (const line of writes) {
    assert.match(line, /datasetChargeKw\(|newRecordCeilingKw\(|= snapshot;/, `an unaccounted writer of maxKw: ${line.trim()}`);
  }
});

test("source guard: a car's name and its label are capped at the same number", () => {
  // They hold the same kind of string. The label is a snapshot of "year make
  // model"; the default name is the make and model out of that same row. Two
  // caps for one quantity is this project's recorded defect shape, and the 40
  // this cap used to carry was sized for a hand-typed nickname on the one
  // custom car that existed then.
  const src = readFileSync(new URL("../js/myCars.js", import.meta.url), "utf8");
  const label = src.match(/const MAX_LABEL_LEN = (\d+)/);
  assert.ok(label, "MAX_LABEL_LEN moved or was renamed");
  assert.equal(Number(label[1]), MAX_CUSTOM_NAME_LEN, "a name and a label disagree about how long a car's words may be");
});

// --- Wiring the store in: selection, editing, and the dual write ------------
//
// main.js now READS a car's numbers from this store and keeps WRITING
// carOverrides, for one release, as the rollback. The risk that carries is
// divergence: if the two disagree, rolling back hands the user numbers they
// never entered and nothing on screen says so, because each store is
// internally consistent.
//
// The last two tests in this section are the ones that matter. The rest cover
// the four functions main.js reaches for.

test("the selected record is answered, and an empty selection is not repaired", () => {
  const state = { v: CARS_V, cars: [car({ id: "c1" }), car({ id: "c2" })], activeId: "c2" };
  assert.equal(activeMyCar(state).id, "c2");
  assert.equal(activeMyCar({ ...state, activeId: null }), null, "no car chosen is a real state");
  assert.equal(activeMyCar({ ...state, activeId: "c9" }), null, "a dangling pointer answers nothing");
  assert.equal(activeMyCar(undefined), null);
  assert.equal(activeMyCar(emptyCarsState()), null);
});

test("picking a car the user already saved finds that record instead of a second one", () => {
  const state = { v: CARS_V, cars: [car({ id: "c1", carId: "volt-2018" }), car({ id: "c2", carId: "prius-2021" })], activeId: "c1" };
  assert.equal(findMyCarByCarId(state, "prius-2021").id, "c2");
  assert.equal(findMyCarByCarId(state, "gone-2019"), null, "nothing saved for it yet");
  assert.equal(findMyCarByCarId(state, null), null);
  assert.equal(findMyCarByCarId(undefined, "volt-2018"), null);

  // Two records may share a carId. The answer is the first, deterministically:
  // a carId cannot say which of two saved Volts the user meant.
  const twins = { v: CARS_V, cars: [car({ id: "c1", name: "Mine" }), car({ id: "c2", name: "Hers" })], activeId: "c1" };
  assert.equal(findMyCarByCarId(twins, "volt-2018").name, "Mine");
});

test("an unedited saved car reads the LIVE dataset row, so a reseed corrects it", () => {
  const saved = { id: "c1", carId: "volt-2018", label: "2018 Chevrolet Volt", name: "" };
  assert.deepEqual(savedCarNumbers(saved, getCar), { mpg: 42, miPerKwh: 3.4, batteryKwh: 18.4 });

  const edited = { ...saved, mpg: 39 };
  assert.deepEqual(savedCarNumbers(edited, getCar), { mpg: 39, miPerKwh: 3.4, batteryKwh: 18.4 }, "what the user typed wins, field by field");
});

test("a car with no dataset row answers only what it holds, so the fields keep what is showing", () => {
  // The custom car. Spreading this over prefs must not blank three fields the
  // user is looking at, which is what an explicit undefined would do.
  const fresh = { id: "c1", carId: CUSTOM_CAR_ID, label: "", name: "Van" };
  assert.deepEqual(savedCarNumbers(fresh, getCar), {}, "nothing to say, so nothing is said");

  const used = { ...fresh, mpg: 26, batteryKwh: 16 };
  assert.deepEqual(savedCarNumbers(used, getCar), { mpg: 26, batteryKwh: 16 }, "miPerKwh stays absent, not undefined");
  assert.equal("miPerKwh" in savedCarNumbers(used, getCar), false);

  // A car whose row was dropped by a reseed is the same case: it keeps its own
  // numbers and stops inheriting ones that no longer exist.
  assert.deepEqual(savedCarNumbers({ id: "c1", carId: "gone-2019", mpg: 44 }, getCar), { mpg: 44 });
});

// --- What a COPY starts from ------------------------------------------------
//
// H-4. "Add a copy" is the route to two records of one model, which is the case
// this feature was asked for, and it used to seed the new record from
// prefs.carOverrides. That store has ONE SLOT PER MODEL, so with two records of
// one model it holds whichever was edited last.

test("savedCarDraft answers only what the record holds, so an unedited car stays on the live row", () => {
  const fresh = { id: "c1", carId: "volt-2018", label: "2018 Chevrolet Volt", name: "", maxKw: 3.6 };
  assert.deepEqual(savedCarDraft(fresh), { maxKw: 3.6 }, "no numbers of its own, so none travel");
  // The copy therefore inherits the same live row the original does, and a
  // reseed that corrects a figure reaches both.
  const copy = addMyCar(emptyCarsState(), { ...savedCarDraft(fresh), carId: fresh.carId, label: fresh.label }, getCar).state.cars[0];
  assert.deepEqual(savedCarNumbers(copy, getCar), savedCarNumbers(fresh, getCar));

  const edited = { ...fresh, mpg: 39, batteryKwh: 17 };
  assert.deepEqual(savedCarDraft(edited), { mpg: 39, batteryKwh: 17, maxKw: 3.6 }, "miPerKwh stays absent, not undefined");
  assert.equal("miPerKwh" in savedCarDraft(edited), false);
});

test("savedCarDraft narrows what it copies and never invents a record\u2019s numbers", () => {
  assert.deepEqual(savedCarDraft(null), {});
  assert.deepEqual(savedCarDraft(undefined), {});
  assert.deepEqual(savedCarDraft(42), {});
  // The same positive rule every other read applies, because this can be handed
  // a record that did not come through the loader.
  for (const bad of [0, -3, NaN, Infinity, "42", null, {}]) {
    assert.deepEqual(savedCarDraft({ id: "c1", mpg: bad, maxKw: bad }), {}, `${String(bad)} is not a number to copy`);
  }
  // And it copies NUMBERS, not identity: a copy is a different car with a
  // different id, and its label and name are the caller's to decide.
  const seeded = savedCarDraft({ id: "c1", carId: "volt-2018", label: "2018 Chevrolet Volt", name: "Van", mpg: 42 });
  assert.deepEqual(Object.keys(seeded).sort(), ["mpg"]);
});

test("A COPY TAKES THE NUMBERS OF THE RECORD ON SCREEN, not the one-slot-per-model override", () => {
  // THE DEFECT, with the two records this feature exists for. Add a Prius,
  // copy it, edit the copy: both stores are written from the same call, so the
  // override now answers for the MODEL with the second record's numbers, and
  // the first record still holds its own. Copying the first used to mint a car
  // carrying the second one's numbers, under the first one's heading, and
  // nothing said so until the user switched chips and came back.
  let state = emptyCarsState();
  for (const name of ["A", "B"]) {
    const res = addMyCar(state, { carId: "prius-2021", label: "2021 Toyota Prius Prime", name }, getCar);
    assert.equal(res.ok, true);
    state = res.state;
  }
  const [a, b] = state.cars;
  assert.equal(a.carId, b.carId, "two records of one model is the case this feature exists for");

  const typed = { mpg: 11, miPerKwh: 2.1, batteryKwh: 9 };
  state = applyMyCarEdit(state, b.id, typed).state;
  const prefs = applyCarEdit(defaultPrefs(), "prius-2021", typed);
  assert.equal(prefs.carOverrides["prius-2021"].mpg, 11, "the one slot per model holds whichever record was edited last");

  // Now copy A, which is the record whose chip is checked.
  const onScreen = state.cars.find((c) => c.id === a.id);
  assert.equal(onScreen.mpg, undefined, "A was never edited");
  const copy = addMyCar(state, { ...savedCarDraft(onScreen), carId: onScreen.carId, label: onScreen.label }, getCar).state.cars[2];

  assert.equal(copy.mpg, undefined, "the other record's 11 did not travel");
  assert.equal(savedCarNumbers(copy, getCar).mpg, DATASET["prius-2021"].mpg, "the copy answers 54, the number on screen");
  assert.deepEqual(savedCarNumbers(copy, getCar), savedCarNumbers(onScreen, getCar), "the copy and its original are the same car");
  assert.notDeepEqual(savedCarNumbers(copy, getCar), savedCarNumbers(state.cars[1], getCar), "and neither of them is B");

  // The other direction: copying B carries B's typed numbers, so the rule is
  // "the record on screen" and not "ignore the numbers".
  const copyOfB = addMyCar(state, { ...savedCarDraft(state.cars[1]), carId: b.carId, label: b.label }, getCar).state.cars[2];
  assert.deepEqual(savedCarNumbers(copyOfB, getCar), { mpg: 11, miPerKwh: 2.1, batteryKwh: 9 });
});

test("an edit keeps the last good value, and the outlet cannot get into a car", () => {
  const state = addMyCar(emptyCarsState(), draft({ carId: "volt-2018" }), getCar).state;
  const id = state.cars[0].id;

  // The whole live input model, outlet and fees included, exactly as main.js
  // hands it over.
  const live = { mpg: 39, miPerKwh: NaN, batteryKwh: 0, powerKw: 7.7, sessionFee: 2, yourRate: 0.31, maxKw: 7.7 };
  const res = applyMyCarEdit(state, id, live);
  assert.equal(res.ok, true);
  const out = res.state.cars[0];
  assert.equal(out.mpg, 39, "the typed value lands");
  assert.equal(out.miPerKwh, 3.4, "a field cleared mid-edit keeps what was saved");
  assert.equal(out.batteryKwh, 18.4, "a zero is refused, not written");
  assert.equal(out.powerKw, undefined, "the outlet is not one of the car's numbers");
  assert.equal(out.maxKw, 3.6, "and the onboard maximum is the dataset's, untouched by the edit");
  assert.equal(JSON.stringify(res.state).includes("7.7"), false);

  assert.equal(res.state.activeId, state.activeId, "editing does not move the selection");
  assert.notEqual(res.state.cars[0], state.cars[0], "pure: the input state is not mutated");
  assert.equal(state.cars[0].mpg, 42);

  const miss = applyMyCarEdit(state, "nope", live);
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, "not-found");
  assert.deepEqual(miss.state, state, "a miss hands back what it was given");
});

// --- Renaming ---------------------------------------------------------------
//
// Next to the edit tests because renameMyCar exists to hold the OPPOSITE merge
// rule: a number cleared mid-edit keeps its last good value, a name cleared
// clears. Nothing above this line observes the rename path at all.

test("a rename lands on the target and leaves every other car untouched", () => {
  const state = fill(3);
  const [first, target, last] = state.cars;

  const res = renameMyCar(state, target.id, "Renamed");
  assert.equal(res.ok, true);
  assert.equal(res.reason, "ok");
  assert.equal(res.state.cars[1].name, "Renamed");
  assert.equal(res.state.cars.length, 3, "a rename is not an add and not a remove");

  // Identity, not deep equality: the map rewrites exactly one slot, so the
  // other two must come back as the very objects that went in.
  assert.equal(res.state.cars[0], first, "the car before the target was rebuilt");
  assert.equal(res.state.cars[2], last, "the car after the target was rebuilt");
  assert.equal(res.state.cars[0].name, "Car 1");
  assert.equal(res.state.cars[2].name, "Car 3");

  // And on the target itself, name is the only field that moved.
  assert.deepEqual({ ...res.state.cars[1], name: target.name }, target, "the rename touched a field other than name");

  assert.notEqual(res.state.cars[1], target, "pure: the input state is not mutated");
  assert.equal(state.cars[1].name, "Car 2");
});

test("renaming a car that is not there says so and changes nothing", () => {
  const state = fill(3);
  const before = structuredClone(state);

  for (const id of ["nope", undefined, null, "", "__proto__"]) {
    const res = renameMyCar(state, id, "Renamed");
    assert.equal(res.ok, false, `${JSON.stringify(id) ?? "undefined"} resolved to a car`);
    assert.equal(res.reason, "not-found");
    assert.deepEqual(res.state, before, "a miss hands back what it was given");
  }
  assert.deepEqual(state, before, "and renamed nothing on the way past");
  assert.equal(state.cars.map((c) => c.name).join(","), "Car 1,Car 2,Car 3");
});

test("renameMyCar tolerates a state that is not one", () => {
  // The rename is reachable from a tampered store, so it has to answer rather
  // than throw into the app the way the loader does.
  for (const bad of [null, undefined, 42, "str", true]) {
    const res = renameMyCar(bad, "c1", "Renamed");
    assert.equal(res.ok, false, `${JSON.stringify(bad) ?? "undefined"} was accepted as a state`);
    assert.equal(res.reason, "not-found");
    assert.deepEqual(res.state, emptyCarsState(), "a state that is not one reads as no cars, never as a crash");
  }

  // An object carrying no usable cars list is the tamper case rather than the
  // crash case: it is handed straight back, because there is nothing to fix.
  assert.deepEqual(renameMyCar({}, "c1", "x").state, {});
  assert.equal(renameMyCar({ cars: "not-a-list" }, "c1", "x").ok, false);
  assert.equal(renameMyCar({ cars: null }, "c1", "x").ok, false);
});

test("a new name is narrowed by cleanName, not stored as typed", () => {
  const state = fill(1);
  const id = state.cars[0].id;
  const rename = (n) => renameMyCar(state, id, n).state.cars[0].name;

  // Every step cleanName owns, observed THROUGH the rename rather than assumed
  // from the fact that the call is written there.
  assert.equal(rename("x".repeat(99)).length, MAX_CUSTOM_NAME_LEN, "an over-long name is not truncated at the cap");
  assert.equal(rename("My\u0000Car\u009F"), "MyCar", "control characters are stored raw");
  assert.equal(rename("Out\u202Elander"), "Outlander", "a bidi override reached a car name");
  assert.equal(rename("My\u200BCar"), "MyCar", "zero width can make two names look equal and compare unequal");
  assert.equal(rename("  My   \t Outlander \n "), "My Outlander", "padding is not trimmed, or runs do not collapse");
  assert.equal(rename("Citro\u0065\u0308n"), "Citro\u00ebn", "one name still has two spellings");

  // Not-a-string becomes empty rather than being stored or thrown on, which is
  // the same move that lets a user take a name back off.
  for (const bad of [undefined, null, 42, {}, [], true]) {
    assert.equal(rename(bad), "", `${JSON.stringify(bad) ?? "undefined"} was stored instead of narrowed to empty`);
  }
  assert.equal(rename(""), "", "a blank name is one the user is allowed to choose");

  // And it is cleanName's rule, not a second spelling of it that agrees by
  // inspection today and drifts later.
  for (const n of ["x".repeat(99), "Out\u202Elander", "  a  \t b  ", "My\u0000Car", 42, null]) {
    assert.equal(rename(n), cleanName(n, MAX_CUSTOM_NAME_LEN), `the rename applied a different rule than the read path: ${JSON.stringify(n) ?? "undefined"}`);
  }
});

test("a rename moves neither the selection nor the payload version", () => {
  const state = fill(3);
  const selected = state.activeId;
  assert.equal(selected, state.cars[0].id, "precondition: the first car added is the selected one");

  // Renaming a car the user is not looking at must not move them, and renaming
  // the one they ARE looking at must not drop them out of it.
  const other = renameMyCar(state, state.cars[2].id, "Renamed");
  assert.equal(other.state.activeId, selected, "renaming another car moved the selection");
  assert.equal(other.state.v, CARS_V);

  const active = renameMyCar(state, selected, "Renamed");
  assert.equal(active.state.activeId, selected, "renaming the selected car deselected it");
  assert.equal(active.state.v, CARS_V);

  // A deliberate no-selection stays that way rather than being repaired into a
  // pick the user never made.
  const none = renameMyCar({ ...state, activeId: null }, state.cars[0].id, "Renamed");
  assert.equal(none.state.activeId, null, "a null selection was repaired into one the user did not make");
  assert.equal(none.state.v, CARS_V);

  // And a version from somewhere else is rewritten to the one this build
  // writes, rather than carried along.
  assert.equal(renameMyCar({ ...state, v: 99 }, state.cars[0].id, "x").state.v, CARS_V);
  assert.equal(renameMyCar({ ...state, v: undefined }, state.cars[0].id, "x").state.v, CARS_V);
});

test("a renamed name is a FIXED POINT, so renaming to an already-cleaned name is idempotent", () => {
  const state = fill(1);
  const id = state.cars[0].id;

  // This is the claim renameMyCar's comment makes and the reason main.js may
  // mirror the result into prefs.customName instead of sanitizing the text a
  // second time: what is written is already narrowed the way the READ path
  // narrows, so it survives the round trip unchanged.
  for (const raw of ["Outlander", "x".repeat(99), "  My   \t Outlander \n ", "My\u0000Car\u009F", "Out\u202Elander", "My\u200BCar", "Citro\u0065\u0308n", "", 42]) {
    const why = JSON.stringify(raw) ?? "undefined";
    const once = renameMyCar(state, id, raw).state;
    const twice = renameMyCar(once, id, once.cars[0].name).state;
    assert.equal(twice.cars[0].name, once.cars[0].name, `renaming to the stored name changed it: ${why}`);

    const loaded = sanitizeCarsPayload(structuredClone(once));
    assert.equal(loaded.cars[0].name, once.cars[0].name, `the read path re-narrowed a name the rename had already narrowed: ${why}`);
  }

  // ONE INPUT IS NOT A FIXED POINT, and it is the cap's edge rather than a
  // missing rule. cleanText trims BEFORE it slices, so a cut that lands on a
  // space leaves a trailing one that a second pass would take off. Pinned
  // because the comment above renameMyCar states the fixed point without this
  // qualifier: if the cap is ever changed to trim after slicing, this is the
  // line that says the claim got stronger.
  const cut = renameMyCar(state, id, `${"a".repeat(MAX_CUSTOM_NAME_LEN - 1)} b`).state.cars[0].name;
  assert.equal(cut, `${"a".repeat(MAX_CUSTOM_NAME_LEN - 1)} `, `the cap sliced somewhere other than the ${MAX_CUSTOM_NAME_LEN}th character`);
  assert.equal(cleanName(cut, MAX_CUSTOM_NAME_LEN), "a".repeat(MAX_CUSTOM_NAME_LEN - 1), "a cut-at-the-cap trailing space no longer survives to a second narrowing");
});

test("a rename at the cap stores a name the browser can still encode", () => {
  // The save path's half of the clip the copy path already had. 63 characters
  // then an emoji is ordinary typing, and it stored half a surrogate pair.
  const state = fill(1);
  const id = state.cars[0].id;
  const name = renameMyCar(state, id, `${"a".repeat(MAX_CUSTOM_NAME_LEN - 1)}\u{1F600}`).state.cars[0].name;
  assert.ok(name.isWellFormed(), `a lone surrogate survived: ${JSON.stringify(name)}`);
  assert.doesNotThrow(() => encodeURIComponent(name));
  assert.equal(name, "a".repeat(MAX_CUSTOM_NAME_LEN - 1));
});

test("DIVERGENCE PIN: the two stores hold the same numbers after every keystroke", () => {
  // The dual write's one real hazard. carOverrides is the rollback, so if it
  // drifts from the saved car, a rollback restores numbers the user never
  // entered. main.js writes both from one call site; this pins that the two
  // MERGE RULES agree, which is the half a single call site cannot guarantee.
  let prefs = legacyPrefs({ carId: "volt-2018", carOverrides: {} });
  prefs = applyCarSelection(prefs, DATASET["volt-2018"]);
  let cars = addMyCar(emptyCarsState(), { carId: "volt-2018", label: labelFor("volt-2018"), name: "" }, getCar).state;
  const id = cars.cars[0].id;

  const agree = (why) => {
    const fromCars = savedCarNumbers(activeMyCar(cars), getCar);
    const fromPrefs = applyCarSelection(prefs, DATASET["volt-2018"]);
    for (const k of CAR_EDIT_FIELDS) assert.equal(fromCars[k], fromPrefs[k], `${k} diverged ${why}`);
  };
  agree("before any edit was made");

  // Every value a number field can hand the app while it is being typed in:
  // a real one, a cleared field, a zero, a negative, then a real one again.
  const typed = [
    { mpg: 39, miPerKwh: 3.1, batteryKwh: 17 },
    { mpg: NaN, miPerKwh: 3.2, batteryKwh: 17 },
    { mpg: 0, miPerKwh: 3.2, batteryKwh: 17 },
    { mpg: -4, miPerKwh: 3.2, batteryKwh: NaN },
    { mpg: 41, miPerKwh: 3.9, batteryKwh: 18 },
  ];
  for (const t of typed) {
    const live = { ...t, powerKw: 7.7, sessionFee: 2, yourRate: 0.31 };
    prefs = applyCarEdit(prefs, "volt-2018", live);
    cars = applyMyCarEdit(cars, id, live).state;
    agree(`after typing ${JSON.stringify(t)}`);
  }

  assert.deepEqual(prefs.carOverrides["volt-2018"], { mpg: 41, miPerKwh: 3.9, batteryKwh: 18 });
  assert.equal(prefs.carOverrides["volt-2018"].powerKw, undefined, "the outlet stayed out of the rollback store too");
});

test("source guard: main.js writes both car stores from exactly one place", () => {
  // A source scan, not a behavior test, in the same spirit as the preset guard
  // in cars.test.mjs: the boot path and the input handlers live in main.js,
  // which needs a DOM and cannot be imported here. The test above pins that the
  // two merge rules AGREE; this one pins that there is one caller, which is
  // what keeps them called with the same values. A failure means "go read the
  // new line", not "a bug is proven". Reformatting will break it; rewrite then.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//"));
  const bodyOf = (decl) => {
    const start = src.indexOf(decl);
    assert.notEqual(start, -1, `${decl} moved or was renamed`);
    return src.slice(start, src.indexOf("\n}", start));
  };

  assert.equal(code.filter((l) => l.includes("applyCarEdit(")).length, 1, "carOverrides is written from more than one place");
  assert.equal(code.filter((l) => l.includes("applyMyCarEdit(")).length, 1, "the saved car is written from more than one place");

  const writer = bodyOf("function saveCarNumbers(");
  for (const call of [/applyCarEdit\(/, /savePrefs\(/, /applyMyCarEdit\(/, /saveMyCars\(/]) {
    assert.match(writer, call, "one of the four writes left the single writer");
  }

  // A saved record pointing at a different car than prefs does must read as
  // absent, or the estimate caps against the wrong onboard charger. This is the
  // one case a single writer cannot cover, because the five-car cap can refuse
  // a car prefs has already accepted.
  assert.match(bodyOf("function activeSavedCar("), /saved\.carId === prefs\.carId/, "the mismatch guard is gone");

  // And nothing may write the store before the one-shot migration has had its
  // chance, because the key's own presence is what records that it ran.
  assert.match(bodyOf("function selectMyCar("), /if \(!myCarsLive\) return null;/, "a selection can now create the store ahead of the migration");
  assert.equal(code.filter((l) => /myCarsLive = true/.test(l)).length, 1, "more than one thing can declare the store live");
  assert.match(bodyOf("function initMyCars("), /myCarsLive = true/, "and it is not initMyCars that does");

  assert.equal(code.filter((l) => l.includes('"__custom__"')).length, 0, "main.js is defining its own custom sentinel again");
});

test("source guard: the estimate caps against the SAVED car, and the migration waits for the dataset", () => {
  // A source scan, not a behavior test, in the same spirit as the preset guard
  // in cars.test.mjs and the single-writer guard above. render(), ceilingCar()
  // and initMyCars() live in main.js, which needs a DOM and cannot be imported
  // here, so nothing in this suite can observe what any of them does.
  //
  // Be exact about what this buys. savedCarCeilingKw is pinned properly above
  // (reseed, no figure, snapshot above, snapshot below) and those are real
  // behavior tests. What was unheld is the WIRING: reverting render()'s second
  // argument to currentCar() uncaps every orphaned saved car and leaves all 224
  // tests green, which makes the entire behavioral delta of this feature a
  // thing held by review alone. This is a tripwire over that revert. It proves
  // the lines are present, and it proves nothing about what they compute. A
  // failure means "go read main.js", not "a bug is proven". Reformatting will
  // break it; rewrite the guard then.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const bodyOf = (decl) => {
    const start = src.indexOf(decl);
    assert.notEqual(start, -1, `${decl} moved or was renamed`);
    return src.slice(start, src.indexOf("\n}", start));
  };

  // Scoped to render() rather than matched anywhere in the file, because
  // currentCar's own comment names the other half of this: hoisting the cap up
  // into readInputs also leaves the suite green, and ratchets a capped value
  // into m.powerKw and on into storage, where it outlives the car that caused it.
  assert.match(bodyOf("function render("), /chargeDrawKw\(m\.powerKw, ceilingCar\(\)\)/, "render() stopped capping against the saved car");

  // And ceilingCar must still BRANCH. Answering currentCar() unconditionally is
  // the same defect one level down, and answering the saved ceiling
  // unconditionally drops the no-car-saved path onto an Infinity carrier.
  const ceiling = bodyOf("function ceilingCar(");
  assert.match(ceiling, /activeSavedCar\(\)/, "ceilingCar stopped consulting the saved record");
  assert.match(ceiling, /savedCarCeilingKw\(saved, getCar\)/, "a saved car's ceiling is no longer read from the saved car");
  assert.match(ceiling, /:\s*currentCar\(\)/, "with nothing saved it must still fall back to the dataset row");

  // migrateIfNeeded is one-shot and snapshots whatever the dataset answers, so
  // running it before the fetch lands spends that single chance on cars with no
  // label and no maxKw.
  //
  // It cannot defend itself, and that is a deliberate choice rather than a gap.
  // A car with no label and no maxKw is also exactly what a legitimately
  // orphaned car looks like, which the suite above pins as a supported state
  // ("uncapped is the honest answer, not 7.77"). A refusal inside
  // migrateIfNeeded keyed on that shape would decline to migrate the real user
  // whose cars the dataset no longer lists, and cost them the numbers the
  // migration exists to carry across. Only the boot boundary can tell "the
  // dataset is not up" from "this car is gone", so the guard belongs there and
  // this pins it there.
  const init = bodyOf("function initMyCars(");
  const guard = init.indexOf("if (!getCars().length) return;");
  assert.notEqual(guard, -1, "the migration can now run with no dataset loaded");
  assert.ok(guard < init.indexOf("migrateIfNeeded("), "the dataset guard no longer runs before the migration");
});

test("source guard: a stale tab re-reads the store, from two triggers and one function", () => {
  // The rule is pinned properly above (reconcileMyCars, refreshMyCars). What no
  // test in this repo can reach is whether main.js ever CALLS it: deleting both
  // listeners leaves all 376 tests green and puts the defect back whole, with a
  // rename in one tab destroying a car saved in another and no page error to
  // show for it. A failure here means "go read main.js", not "a bug is proven".
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//"));
  const start = src.indexOf("function refreshMyCarsFromStore(");
  assert.notEqual(start, -1, "the re-read is gone from main.js");
  const refresh = src.slice(start, src.indexOf("\n}", start));

  assert.match(refresh, /refreshMyCars\(myCars\.activeId\)/, "the refresh stopped re-reading the store, or stopped keeping this tab's selection");

  // BOTH triggers, reaching the SAME function. Two implementations of "reload
  // from disk" is the two-writers defect this project has already been bitten
  // by, one layer up.
  const triggers = [...src.matchAll(/refreshMyCarsFromStore\(\)/g)]
    .map((m) => src.slice(Math.max(0, m.index - 400), m.index))
    .filter((before) => !before.endsWith("function ")); // the declaration itself
  assert.equal(triggers.length, 2, `the re-read has ${triggers.length} call sites, not the two listeners`);
  assert.ok(
    triggers.some((t) => t.includes('addEventListener("storage"')),
    "nothing re-reads when another tab writes, so a foreground tab stays stale until it is hidden and shown",
  );
  assert.ok(
    triggers.some((t) => t.includes('addEventListener("visibilitychange"')),
    "nothing re-reads when the tab returns, so a tab frozen with its storage events dropped never catches up",
  );

  // The storage listener has to know its own store, and only its own.
  const at = src.indexOf('window.addEventListener("storage"');
  const listener = src.slice(at, src.indexOf("});", at));
  assert.match(listener, /e\.key !== CARS_KEY/, "the storage listener stopped filtering on the saved-cars key");
  assert.match(listener, /e\.key !== null/, "a cleared store no longer reaches the refresh");
  assert.equal(code.filter((l) => l.includes('"sicc.cars.v1"')).length, 0, "main.js is spelling the store key itself again");

  // And deliberately NOT the prefs key. render() persists on every keystroke,
  // and render() is also what a prefs refresh would have to call to be worth
  // anything, so a prefs listener is a write answering a write in both
  // directions, forever.
  assert.equal(code.filter((l) => l.includes('"sicc.prefs.v1"')).length, 0, "main.js can now listen for the store that render() writes on every keystroke");

  // A REFRESH IS A READ. Any write here fires a storage event back at the tab
  // that caused it, and the two tabs never settle.
  const body = refresh.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const write of ["saveMyCars(", "savePrefs(", "clearMyCars(", "switchToMyCar(", "setActiveMyCar(", "render()"]) {
    assert.ok(!body.includes(write), `${write} is on the refresh path, so a refresh answers a write with a write`);
  }

  // The name field is the one thing on screen the user can be holding when a
  // refresh lands, and the refresh may not take a keystroke back. That rule now
  // sits in the repaint both the refresh and the name field's own blur go
  // through, so the guard follows it there rather than pinning a copy of it.
  assert.match(body, /repaintCarName\(\)/, "the refresh names the active car its own way again");
  const paintAt = src.indexOf("function repaintCarName(");
  assert.notEqual(paintAt, -1, "repaintCarName moved or was renamed");
  const repaint = src.slice(paintAt, src.indexOf("\n}", paintAt));
  assert.match(repaint, /document\.activeElement !== field/, "the refresh overwrites the name field while the user is typing in it");

  // And a question about a car another tab has already removed must not simply
  // sit there waiting to do nothing. askRemoveCar pins which car it is about;
  // this is the other half, closing the question once that car is gone.
  assert.match(body, /dlg\.close\(/, "a question about a car another tab removed stays open");
  assert.match(body, /removeGoneMessage\(/, "and it closes without saying why");
});

test("source guard: the remove question is answered about the car it named", () => {
  // Tab A opens the question about one car, tab B removes that car, tab A
  // confirms: re-finding the ACTIVE record on the way back found the successor
  // the removal had selected, and the answer the user gave about one car was
  // spent on another. The store went from three cars to one.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const bodyOf = (decl) => {
    const start = src.indexOf(decl);
    assert.notEqual(start, -1, `${decl} moved or was renamed`);
    return src.slice(start, src.indexOf("\n}", start));
  };

  assert.match(bodyOf("function askRemoveCar("), /removingCarId = saved\.id/, "the question no longer records which car it is about");

  // The lookup line specifically, not the function: reading the successor back
  // AFTER the removal is still activeMyCar's job and always was.
  const act = bodyOf("function removeActiveCar(");
  const found = act.split("\n").find((l) => l.includes("const saved ="));
  assert.ok(found, "removeActiveCar stopped finding a record at all");
  assert.match(found, /removingCarId/, "the act is back on whatever is selected when the answer arrives");
});


