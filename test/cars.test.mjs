// cars.test.mjs - assertions for the car's charge-power ceiling and the draw
// derived from it.
// Run with:  node --test
// No framework, no dependencies (uses the built-in node:test runner).

import { test } from "node:test";
import assert from "node:assert/strict";

import { carCeilingKw, chargeDrawKw, presetMatchesKw } from "../js/cars.js";

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

// --- Presets highlight at the value clicking them would actually produce ---

test("a preset highlights at its capped value, not its label value", () => {
  // Level 2 on a 3.3 kW car writes 3.3 into the field, so 3.3 is what has to
  // light the button up. Comparing against the uncapped 6.6 leaves the preset
  // the user just clicked looking unselected.
  assert.equal(presetMatchesKw(3.3, 6.6, SLOW), true, "Level 2 on a car that tops out at 3.3");
  assert.equal(presetMatchesKw(6.6, 6.6, SLOW), false, "6.6 is not reachable on this car");
  assert.equal(presetMatchesKw(6.6, 6.6, FAST), true);
  assert.equal(presetMatchesKw(1.4, 1.4, SLOW), true, "Level 1 is under every ceiling");
});

test("a hand-typed power between the presets highlights neither", () => {
  assert.equal(presetMatchesKw(4.8, 1.4, FAST), false);
  assert.equal(presetMatchesKw(4.8, 6.6, FAST), false);
});

test("an empty or unreadable power field highlights nothing", () => {
  assert.equal(presetMatchesKw(NaN, 6.6, FAST), false, "empty field");
  assert.equal(presetMatchesKw(6.6, NaN, FAST), false, "unreadable preset");
});
