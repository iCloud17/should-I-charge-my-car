// cars.test.mjs - assertions for the car's charge-power ceiling, the draw
// derived from it, and the preset rules built on both.
// Run with:  node --test
// No framework, no dependencies (uses the built-in node:test runner).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { carCeilingKw, chargeDrawKw, presetMatchesKw, MAX_OUTLET_KW } from "../js/cars.js";

const SLOW = { id: "slow-phev", mpg: 25, miPerKwh: 2.4, batteryKwh: 12, chargeKw: 3.3 };
const FAST = { id: "fast-phev", mpg: 38, miPerKwh: 2.6, batteryKwh: 18, chargeKw: 7.4 };

// --- The ceiling is a fact about the car, and about nothing else ---

test("a saved per-car powerKw does not become the car's ceiling", () => {
  // Stores written by an older release still hold a per-car powerKw, from when
  // this field doubled as the car's onboard limit. It's the OUTLET the user was
  // standing at, so reading it back here turns one 3.3 kW stop into a permanent
  // cap on a 6.6 kW car. Nothing but the car may change these answers, so the
  // legacy prefs are handed in as a second argument that must be ignored.
  const legacyPrefs = {
    carId: SLOW.id,
    powerKw: 3.3,
    carOverrides: { "fast-phev": { mpg: 38, powerKw: 3.3 } },
  };
  assert.equal(carCeilingKw(FAST, legacyPrefs), 7.4, "the ceiling is the car's rated max");
  assert.equal(chargeDrawKw(6.6, FAST, legacyPrefs), 6.6, "so a 6.6 kW outlet still delivers 6.6");
});

test("a car with no rated charge power has no ceiling", () => {
  assert.equal(carCeilingKw(null), Infinity, "no car picked yet");
  assert.equal(carCeilingKw({ id: "__custom__", mpg: 30 }), Infinity, "a car the user typed in");
  assert.equal(carCeilingKw({ id: "x", chargeKw: null }), Infinity, "a car the dataset has no figure for");
  assert.equal(chargeDrawKw(6.6, null), 6.6, "an unknown car draws whatever the outlet gives");
});

// --- The draw: the lesser of the two, worked out where the number is used ---

test("the car draws the lesser of the outlet and its onboard charger", () => {
  assert.equal(chargeDrawKw(6.6, SLOW), 3.3, "a Level 2 outlet on a 3.3 kW car");
  assert.equal(chargeDrawKw(1.4, SLOW), 1.4, "a Level 1 outlet the car outruns");
  assert.equal(chargeDrawKw(6.6, FAST), 6.6, "an outlet the car could outrun");
});

test("an unreadable power field stays unreadable rather than becoming a number", () => {
  // An empty box parses as non-finite. Quietly substituting the car's ceiling
  // would show a charge time for a charger the user never told us about.
  assert.equal(Number.isNaN(chargeDrawKw(NaN, SLOW)), true);
  assert.equal(Number.isNaN(chargeDrawKw(NaN, null)), true);
});

// --- The outlet's own ceiling: the only bound a custom car has ---

test("the outlet ceiling is an AC figure, not a DC fast-charging one", () => {
  // The number is load-bearing, not decorative: a DC-sized ceiling would let a
  // PHEV estimate run at a rate no plug-in hybrid can physically accept.
  assert.equal(MAX_OUTLET_KW, 22);
});

test("an absurd outlet figure cannot drive the estimate", () => {
  // A custom car has no rated charge power, so carCeilingKw is Infinity and the
  // car cannot bound anything. Without the outlet ceiling the estimate renders
  // "0 min at 99999999 kW" with a straight face.
  const custom = { id: "__custom__", mpg: 30 };
  assert.equal(chargeDrawKw(99999999, custom), MAX_OUTLET_KW);
  assert.equal(chargeDrawKw(99999999, null), MAX_OUTLET_KW);
  assert.equal(chargeDrawKw(Infinity, custom), MAX_OUTLET_KW);
});

test("the car's onboard charger still wins when it is the lower of the two", () => {
  assert.equal(chargeDrawKw(99999999, SLOW), 3.3, "the ceiling never raises the draw");
  assert.equal(chargeDrawKw(99999999, FAST), 7.4);
});

test("every real outlet passes through the ceiling untouched", () => {
  // Level 1 through the fastest three-phase wallbox. If any of these moved, the
  // ceiling would be bounding ordinary use rather than nonsense.
  for (const kw of [1.4, 1.9, 3.3, 3.6, 6.6, 7.2, 7.4, 9.6, 11, 19.2, 22]) {
    assert.equal(chargeDrawKw(kw, null), kw, `${kw} kW is a real outlet`);
  }
});

// --- Presets highlight at their own value, because the field is the outlet ---

test("a preset highlights at its label value on every car", () => {
  // Level 2 means a 6.6 kW outlet, so 6.6 in the field lights it up whatever
  // car is selected. Comparing against the car-capped value instead left the
  // button dark on every car rated under 6.6, which is most of the dataset at
  // the field's 6.6 default, so a typical first load showed nothing selected.
  assert.equal(presetMatchesKw(6.6, 6.6, SLOW), true, "a 3.3 kW car at a Level 2 outlet");
  assert.equal(presetMatchesKw(6.6, 6.6, FAST), true);
  assert.equal(presetMatchesKw(1.4, 1.4, SLOW), true, "Level 1 is under every ceiling");
  assert.equal(presetMatchesKw(3.3, 6.6, SLOW), false, "3.3 is the car's ceiling, not an outlet preset");
});

test("the car cannot change which preset is highlighted", () => {
  // The car is not a parameter, and passing one anyway must leave the answer
  // alone. This is the guard against the cap creeping back into the compare.
  for (const car of [SLOW, FAST, null, undefined, { id: "x", chargeKw: 1.7 }]) {
    assert.equal(presetMatchesKw(6.6, 6.6, car), true, "Level 2 against a 6.6 field");
    assert.equal(presetMatchesKw(1.4, 6.6, car), false, "Level 2 against a 1.4 field");
  }
});

test("the QA case: Level 2 lights up on a 1.7 kW car while the estimate stays capped", () => {
  // The screen state this fix is for. The field holds the outlet (6.6), so the
  // Level 2 button is lit and honest about where the user is standing. The
  // estimate still runs at what the car can actually pull (1.7). Both numbers
  // are true at once; neither is allowed to overwrite the other.
  const VALHALLA = { id: "valhalla", chargeKw: 1.7 };
  assert.equal(presetMatchesKw(6.6, 6.6, VALHALLA), true, "Level 2 is lit");
  assert.equal(presetMatchesKw(6.6, 1.4, VALHALLA), false, "Level 1 is not");
  assert.equal(chargeDrawKw(6.6, VALHALLA), 1.7, "and the estimate still caps at the onboard charger");
});

test("a hand-typed power between the presets highlights neither", () => {
  assert.equal(presetMatchesKw(4.8, 1.4, FAST), false);
  assert.equal(presetMatchesKw(4.8, 6.6, FAST), false);
});

test("an empty or unreadable power field highlights nothing", () => {
  assert.equal(presetMatchesKw(NaN, 6.6, FAST), false, "empty field");
  assert.equal(presetMatchesKw(6.6, NaN, FAST), false, "unreadable preset");
});

// --- The preset WRITE path, guarded by reading source rather than running it ---
//
// Be clear about what this is: a source scan, not a behavior test. The click
// handler lives in main.js, which needs a DOM and cannot be imported here, so
// nothing in this suite can observe the value it writes. What can be checked is
// that the writing line still derives from the preset's own label value and
// never routes through a cap. A failure means "go read the handler", not "a bug
// is proven". Reformatting the handler will break this; rewrite the guard then.

test("source guard: the preset click handler writes the preset's own kW, uncapped", () => {
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const start = src.indexOf('$("powerPresets").addEventListener("click"');
  assert.notEqual(start, -1, "the preset click handler moved or was renamed");

  const end = src.indexOf("\n  });", start);
  assert.notEqual(end, -1, "could not find the end of the handler");
  const body = src.slice(start, end)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  const write = body.split("\n").find((line) => line.includes('$("powerKw").value'));
  assert.ok(write, "the handler no longer writes the power field");
  assert.match(write, /btn\.dataset\.kw/, "the value written must be the preset's own");
  assert.doesNotMatch(
    body,
    /chargeDrawKw|carCeilingKw|currentCar|Math\.min/,
    "a cap on this path reaches m.powerKw and then storage, outliving the car that caused it",
  );
});
