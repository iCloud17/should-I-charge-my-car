import { test } from "node:test";
import assert from "node:assert/strict";
import {
  labels,
  economyForDisplay,
  economyToCanonical,
  efficiencyForDisplay,
  gasPriceForDisplay,
  gasPriceToCanonical,
  impMpgFromUsMpg,
  usMpgFromImpMpg,
  kmPerLFromMpg,
  mpgFromKmPerL,
  kmPerKwhFromMiPerKwh,
  miPerKwhFromKmPerKwh,
  efficiencyToCanonical,
  LITERS_PER_GALLON,
  KM_PER_MILE,
  IMP_PER_US_MPG,
} from "../js/units.js";

const approx = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ~= ${b}`);

test("imperial gallon is ~20% larger than US gallon", () => {
  approx(IMP_PER_US_MPG, 4.54609 / 3.785411784);
  assert.ok(IMP_PER_US_MPG > 1.2 && IMP_PER_US_MPG < 1.201);
});

test("UK shows imperial-gallon MPG (~20% higher number than US)", () => {
  approx(impMpgFromUsMpg(52), 52 * IMP_PER_US_MPG);
  // A 52 US-MPG car reads ~62.4 UK MPG.
  assert.ok(Math.abs(impMpgFromUsMpg(52) - 62.45) < 0.1);
  approx(usMpgFromImpMpg(impMpgFromUsMpg(52)), 52);
});

test("economy display/canonical is US-invariant and UK round-trips", () => {
  assert.equal(economyForDisplay(52, "imperial"), 52); // US unchanged
  approx(economyForDisplay(52, "uk"), 52 * IMP_PER_US_MPG);
  approx(economyToCanonical(economyForDisplay(52, "uk"), "uk"), 52);
  approx(economyToCanonical(economyForDisplay(4.52, "metric"), "metric"), 4.52);
});

test("UK prices fuel per liter, same as metric; US per gallon", () => {
  // $3.785411784 per US gallon == $1.00 per liter.
  approx(gasPriceForDisplay(LITERS_PER_GALLON, "uk"), 1);
  approx(gasPriceForDisplay(LITERS_PER_GALLON, "metric"), 1);
  assert.equal(gasPriceForDisplay(3.89, "imperial"), 3.89); // US unchanged
  // Round-trips back to canonical $/US-gallon.
  approx(gasPriceToCanonical(1, "uk"), LITERS_PER_GALLON);
  approx(gasPriceToCanonical(gasPriceForDisplay(3.89, "uk"), "uk"), 3.89);
});

test("EV efficiency stays mi/kWh for US and UK, converts only for metric", () => {
  assert.equal(efficiencyForDisplay(3.57, "imperial"), 3.57);
  assert.equal(efficiencyForDisplay(3.57, "uk"), 3.57); // UK uses mi/kWh
  assert.notEqual(efficiencyForDisplay(3.57, "metric"), 3.57);
});

test("labels: UK is miles + MPG + liter; metric is km + L/100km", () => {
  assert.deepEqual(labels("uk"), {
    fuelEconomy: "MPG",
    evEfficiency: "mi/kWh",
    gasVolume: "liter",
    distance: "mi",
  });
  assert.deepEqual(labels("imperial"), {
    fuelEconomy: "MPG",
    evEfficiency: "mi/kWh",
    gasVolume: "gallon",
    distance: "mi",
  });
  assert.equal(labels("metric").distance, "km");
});

test("kmL: economy is km/L (distance per litre) round-tripping US MPG", () => {
  // A 52 US-MPG car reads ~22.1 km/L.
  approx(kmPerLFromMpg(52), 52 * KM_PER_MILE / LITERS_PER_GALLON);
  assert.ok(Math.abs(kmPerLFromMpg(52) - 22.1) < 0.1);
  approx(mpgFromKmPerL(kmPerLFromMpg(52)), 52);
  approx(economyForDisplay(52, "kmL"), kmPerLFromMpg(52));
  approx(economyToCanonical(economyForDisplay(52, "kmL"), "kmL"), 52);
});

test("kmL: EV efficiency is km/kWh (denpi), round-tripping mi/kWh", () => {
  // 3.57 mi/kWh -> ~5.746 km/kWh.
  approx(kmPerKwhFromMiPerKwh(3.57), 3.57 * KM_PER_MILE);
  assert.ok(Math.abs(kmPerKwhFromMiPerKwh(3.57) - 5.746) < 0.01);
  approx(miPerKwhFromKmPerKwh(kmPerKwhFromMiPerKwh(3.57)), 3.57);
  approx(efficiencyForDisplay(3.57, "kmL"), kmPerKwhFromMiPerKwh(3.57));
  approx(efficiencyToCanonical(efficiencyForDisplay(3.57, "kmL"), "kmL"), 3.57);
  assert.equal(efficiencyForDisplay(3.57, "imperial"), 3.57); // US unchanged
});

test("kmL prices fuel per liter, same as metric (not per gallon)", () => {
  approx(gasPriceForDisplay(LITERS_PER_GALLON, "kmL"), 1);
  approx(gasPriceForDisplay(3.89, "kmL"), gasPriceForDisplay(3.89, "metric"));
  approx(gasPriceToCanonical(gasPriceForDisplay(3.89, "kmL"), "kmL"), 3.89);
});

test("labels: kmL is km + km/L + km/kWh + liter", () => {
  assert.deepEqual(labels("kmL"), {
    fuelEconomy: "km/L",
    evEfficiency: "km/kWh",
    gasVolume: "liter",
    distance: "km",
  });
});
