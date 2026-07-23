// calc.test.mjs - assertions for the pure math core.
// Run with:  node --test
// No framework, no dependencies (uses the built-in node:test runner).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  breakevenKwhPrice,
  powerAtSoc,
  verdict,
  rateAtTime,
  cheapestPeriod,
  rateAtElapsed,
  timeFeeCost,
  chargeCurve,
} from "../js/calc.js";

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

test("breakevenKwhPrice = gasPrice * miPerKwh / mpg", () => {
  assert.ok(near(breakevenKwhPrice({ gasPrice: 4, mpg: 40, miPerKwh: 2.5 }), 0.25));
  assert.ok(near(breakevenKwhPrice({ gasPrice: 3.89, mpg: 38, miPerKwh: 2.5 }), 3.89 * 2.5 / 38));
});

test("breakevenKwhPrice rejects invalid inputs", () => {
  assert.ok(Number.isNaN(breakevenKwhPrice({ gasPrice: 4, mpg: 0, miPerKwh: 2.5 })));
  assert.ok(Number.isNaN(breakevenKwhPrice({ gasPrice: 4, mpg: 40, miPerKwh: 0 })));
  assert.ok(Number.isNaN(breakevenKwhPrice({ gasPrice: -1, mpg: 40, miPerKwh: 2.5 })));
});

test("powerAtSoc: flat below the knee, tapers above it", () => {
  assert.equal(powerAtSoc(50, 6.6), 6.6);          // well below knee
  assert.equal(powerAtSoc(92.5, 6.6), 6.6);         // exactly at the knee
  assert.ok(near(powerAtSoc(100, 6.6), 6.6 * 0.25)); // taperEndFactor at 100%
  assert.ok(near(powerAtSoc(96.25, 6.6), 6.6 * 0.625)); // halfway through the CV taper
});

test("verdict buckets around break-even with an 8% band", () => {
  assert.equal(verdict(0.20, 0.25), "worth"); // <= 0.23
  assert.equal(verdict(0.30, 0.25), "gas");   // >= 0.27
  assert.equal(verdict(0.25, 0.25), "close"); // inside the band
  assert.equal(verdict(0.25, NaN), "unknown");
  assert.equal(verdict(NaN, 0.25), "unknown");
});

test("timeFeeCost integrates tiered by-the-hour fees", () => {
  const tiers = [{ start: 0, perHour: 2.04 }, { start: 240, perHour: 5 }];
  assert.equal(timeFeeCost(tiers, 0), 0);
  assert.ok(near(timeFeeCost(tiers, 60), 2.04));           // 1 hr in tier 1
  assert.ok(near(timeFeeCost(tiers, 240), 4 * 2.04));       // exactly 4 hrs
  assert.ok(near(timeFeeCost(tiers, 300), 4 * 2.04 + 5));   // 4 hrs + 1 hr in tier 2
  assert.equal(timeFeeCost([], 120), 0);                    // no tiers
});

test("rateAtTime picks the active period and wraps past midnight", () => {
  const sched = [{ start: 0, rate: 0.10 }, { start: 960, rate: 0.40 }]; // peak from 16:00
  assert.equal(rateAtTime(sched, 600), 0.10);  // 10:00, off-peak
  assert.equal(rateAtTime(sched, 1000), 0.40); // 16:40, peak
  assert.equal(rateAtTime(sched, 30), 0.10);   // 00:30 wraps to the pre-16:00 rate
});

test("cheapestPeriod finds the lowest rate with a wrap-aware window", () => {
  const cheap = cheapestPeriod([{ start: 0, rate: 0.30 }, { start: 960, rate: 0.10 }]);
  assert.equal(cheap.rate, 0.10);
  assert.equal(cheap.start, 960);
  assert.equal(cheap.end, 0); // wraps back to the first period
});

test("rateAtElapsed steps up by charging duration", () => {
  const tiers = [{ start: 0, rate: 0.30 }, { start: 60, rate: 0.50 }];
  assert.equal(rateAtElapsed(tiers, 0), 0.30);
  assert.equal(rateAtElapsed(tiers, 30), 0.30);
  assert.equal(rateAtElapsed(tiers, 90), 0.50);
});

test("chargeCurve: flat rate with no fees yields effective == rate", () => {
  const c = chargeCurve({
    batteryKwh: 10, startPct: 0, targetPct: 100, powerKw: 10,
    rateOf: () => 0.30, sessionFee: 0, timeTiers: [], breakeven: NaN,
  });
  assert.ok(near(c.kwhIntoBattery, 10, 1e-3));
  assert.ok(near(c.kwhFromCharger, 10 / 0.88, 1e-3)); // post-loss energy
  assert.ok(near(c.effectivePerKwh, 0.30, 1e-6));      // fee-free average == rate
  assert.ok(c.fullMinutes > 0);
  assert.equal(c.soc, 100);
});

test("chargeCurve: a session fee raises the effective price by fee/kWh", () => {
  const c = chargeCurve({
    batteryKwh: 10, startPct: 0, targetPct: 100, powerKw: 10,
    rateOf: () => 0.30, sessionFee: 2, timeTiers: [], breakeven: NaN,
  });
  assert.ok(near(c.effectivePerKwh, 0.30 + 2 / (10 / 0.88), 1e-6));
});

test("chargeCurve: capping the time gives a partial charge", () => {
  const args = {
    batteryKwh: 15, startPct: 0, targetPct: 100, powerKw: 6.6,
    rateOf: () => 0.30, sessionFee: 0, timeTiers: [], breakeven: NaN,
  };
  const full = chargeCurve({ ...args, capMinutes: Infinity });
  const partial = chargeCurve({ ...args, capMinutes: 30 });
  assert.ok(near(partial.minutes, 30, 1e-6));
  assert.ok(partial.kwhFromCharger < full.kwhFromCharger);
  assert.ok(partial.soc < full.soc);
  assert.ok(partial.soc > 0);
});

test("chargeCurve: time fee flips worth-it and sets a worth limit", () => {
  const base = {
    batteryKwh: 15, startPct: 0, targetPct: 100, powerKw: 6.6,
    rateOf: () => 0, sessionFee: 0.25, breakeven: 0.26,
  };
  // Free energy but a steep by-the-hour fee: never beats gas.
  const steep = chargeCurve({ ...base, timeTiers: [{ start: 0, perHour: 2.04 }] });
  assert.equal(steep.everWorth, false);

  // Free energy and a free "time fee": always beats gas, worth limit == full charge.
  const freebie = chargeCurve({ ...base, sessionFee: 0, timeTiers: [{ start: 0, perHour: 0 }] });
  assert.equal(freebie.everWorth, true);
  assert.ok(near(freebie.worthLimitMin, freebie.fullMinutes, 1e-6));
});
