// cardUi.test.mjs - behavior tests for the result card's pure rules.
// Run with:  node --test
//
// These three were untestable while they lived in main.js, which touches the
// DOM at load: inclusionNote could only be lifted out of the source text with
// new Function, and numText and fmtClock were not covered at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inclusionNote, numText, fmtClock, cardFor, advancedFor, chargeForReadout, chargeForSlider, rememberedChargeFor, effectivePerKwh, speedSummary } from "../js/cardUi.js";
import { rateAtTime, rateAtElapsed } from "../js/calc.js";

// --- The price the card judges ------------------------------------------------

// A custom car with no battery size buys no kWh the card can count, so it is
// judged on the energy rate alone. Outside Flat that is the mode's own rate:
// Energy rate is hidden there and can still hold a price typed before the
// switch, which is what m.yourRate carries here.
const unsized = { m: { yourRate: 0.3 }, hasRate: true, kwh: 0, session: { effectivePerKwh: NaN }, taxRate: 0.1 };
const flatRateOf = () => 0.3;

test("with no battery size, Time of day is judged on its own rate now, not the hidden flat one", () => {
  const schedule = [{ start: 0, rate: 0.25 }, { start: 960, rate: 0.45 }];
  const rateOf = (clock) => rateAtTime(schedule, clock);
  assert.equal(effectivePerKwh({ ...unsized, rateOf, startClockMin: 17 * 60 }), 0.45 * 1.1, "the evening rate was not the one judged");
  assert.equal(effectivePerKwh({ ...unsized, rateOf, startClockMin: 9 * 60 }), 0.25 * 1.1, "the morning rate was not the one judged");
});

test("with no battery size, By duration is judged on the tier it starts on, not the hidden flat rate", () => {
  const tiers = [{ start: 0, rate: 0.2 }, { start: 60, rate: 0.45 }];
  const rateOf = (_clock, elapsed) => rateAtElapsed(tiers, elapsed);
  assert.equal(effectivePerKwh({ ...unsized, rateOf, startClockMin: 0 }), 0.2 * 1.1);
});

test("with no battery size, Flat is judged on Energy rate plus tax", () => {
  assert.equal(effectivePerKwh({ ...unsized, rateOf: flatRateOf, startClockMin: 0 }), 0.3 * 1.1);
});

test("a sized charge is judged on its all-in average, and no price on nothing", () => {
  const session = { effectivePerKwh: 0.61 };
  assert.equal(effectivePerKwh({ ...unsized, kwh: 12, session, rateOf: flatRateOf, startClockMin: 0 }), 0.61);
  assert.ok(Number.isNaN(effectivePerKwh({ ...unsized, hasRate: false, rateOf: flatRateOf, startClockMin: 0 })));
});

// --- What the effective rate says it includes -------------------------------

// A sales tax is not a fee, but hasFees folds one in (deliberately: showEffective
// wants either). Hung off that, the note called a tax-only rate "incl. fees".
test("the effective-rate note names a tax as a tax", () => {
  assert.equal(inclusionNote(true, false), " incl. tax", "a sales tax on its own is still reported as a fee");
  assert.equal(inclusionNote(false, true), " incl. fees", "the session and per-hour fees lost their name");
  assert.equal(inclusionNote(true, true), " incl. tax and fees", "a rate carrying both names only one of them");
  assert.equal(inclusionNote(false, false), "", "the note appears with neither a tax nor a fee behind it");
});

// --- Trimming a number for the field it is painted into ---------------------

test("numText trims to the decimals asked for, halves going up", () => {
  assert.equal(numText(7.456, 2), "7.46");
  assert.equal(numText(7.454, 2), "7.45");
  assert.equal(numText(0.125, 2), "0.13");
  assert.equal(numText(7.6, 0), "8");
});

test("numText drops trailing zeros instead of padding out to the decimals", () => {
  // Why a field reads "7" and not "7.00": the digits asked for are a ceiling.
  assert.equal(numText(7, 2), "7");
  assert.equal(numText(7.1, 2), "7.1");
  assert.equal(numText(0, 2), "0");
  assert.equal(numText(9.999, 2), "10", "a carry into the next whole number kept a stale decimal");
});

test("numText keeps a negative sign", () => {
  assert.equal(numText(-7.456, 2), "-7.46");
});

test("numText hands back a string, never a number", () => {
  // paint() assigns this straight to a field's value.
  assert.equal(typeof numText(7, 2), "string");
  assert.equal(typeof numText(NaN, 2), "string");
});

test("numText answers empty for anything non-finite", () => {
  // The gate that keeps NaN off the screen.
  assert.equal(numText(NaN, 2), "");
  assert.equal(numText(Infinity, 2), "");
  assert.equal(numText(-Infinity, 2), "");
});

// --- Reading a minute-of-day as a clock time --------------------------------

test("fmtClock reads midnight and noon as 12, not 0", () => {
  assert.equal(fmtClock(0), "12:00 AM");
  assert.equal(fmtClock(720), "12:00 PM");
});

test("fmtClock turns over from AM to PM at noon, not at 1", () => {
  assert.equal(fmtClock(719), "11:59 AM");
  assert.equal(fmtClock(720), "12:00 PM");
  assert.equal(fmtClock(780), "1:00 PM");
  assert.equal(fmtClock(1439), "11:59 PM");
});

test("fmtClock pads the minute to two digits and leaves the hour bare", () => {
  assert.equal(fmtClock(5), "12:05 AM");
  assert.equal(fmtClock(60), "1:00 AM");
  assert.equal(fmtClock(70), "1:10 AM");
});

test("fmtClock wraps a minute from outside the day back into it", () => {
  assert.equal(fmtClock(1440), "12:00 AM");
  assert.equal(fmtClock(1500), "1:00 AM");
  assert.equal(fmtClock(-60), "11:00 PM");
  assert.equal(fmtClock(-1), "11:59 PM");
});

test("fmtClock rounds a fractional minute before splitting off the hour", () => {
  assert.equal(fmtClock(59.6), "1:00 AM", "a fraction was truncated, so 59.6 stayed in the 12 o'clock hour");
  assert.equal(fmtClock(59.4), "12:59 AM");
});

test("fmtClock answers a dash for anything non-finite, like money", () => {
  // It is painted into the time-of-day note beside money(), which writes "-"
  // for an unknown price. "NaN:NaN PM" reached the card as text before this.
  assert.equal(fmtClock(NaN), "-");
  assert.equal(fmtClock(Infinity), "-");
  assert.equal(fmtClock(-Infinity), "-");
});

// --- The whole result card, as a value --------------------------------------
//
// cardFor is the four-arm chain lifted out of render(). These tests assert on
// what it RETURNS, which is the point of lifting it: until now the same rules
// could only be checked by reading main.js as text or by driving a browser.

// Lands in the fourth arm with a confident "worth": a $4.00/gal 30 MPG car at
// 3.5 mi/kWh breaks even at $0.4667/kWh and the charger is $0.15. yourRate is
// deliberately NOT effective, so a detail line proves which field it read.
const MODEL = () => ({
  m: { gasPrice: 4, mpg: 30, miPerKwh: 3.5, yourRate: 0.12, startPct: 20, targetPct: 80 },
  be: 0.4666666666666667,
  cur: "$",
  units: "imperial",
  hasRate: true,
  session: { totalCost: 3.25, minutes: 90, soc: 80, kwhFromCharger: 10 },
  full: { worthLimitSoc: 60, fullMinutes: 120 },
  drawKw: 7.2,
  effective: 0.15,
  showEffective: false,
  inclNote: "",
  rateMode: "flat",
  schedule: null,
  hasTimeTiers: false,
  worthLimitMin: null,
  fullNotWorth: false,
  tip: null,
  showBriefly: false,
  now: 600,
});

const card = (over = {}) => {
  const base = MODEL();
  return cardFor({
    ...base, ...over,
    m: { ...base.m, ...(over.m || {}) },
    session: { ...base.session, ...(over.session || {}) },
  });
};

// --- Arm 1: no break-even (no gas price, or no car) -------------------------

test("without a gas price but with a priced charge, the card costs the stop", () => {
  const c = card({ be: NaN, showEffective: true, effective: 0.18, inclNote: " incl. tax" });
  assert.equal(c.verdict, "none", "a cost with no verdict behind it must not paint a verdict colour");
  assert.equal(c.headline, "$3.25");
  assert.equal(c.sub, "Cost of this charge. Add your gas price to see if it beats filling up.");
  assert.deepEqual(c.detailLine, { hidden: false, text: "Effective $0.18/kWh incl. tax" });
  assert.deepEqual(c.timeline, { hidden: false, text: "Est. 1 hr 30 min to 80% at 7.2 kW" });
});

test("the cost card quotes the rate as entered when nothing else is in it", () => {
  // The other half of arm 1's detail line, and the reason it is a half: there
  // is no break-even to put beside the rate here, only a NaN.
  const c = card({ be: NaN, showEffective: false });
  assert.deepEqual(c.detailLine, { hidden: false, text: "You pay $0.12/kWh" });
});

test("the cost card asks for the car when the car is what is missing", () => {
  const c = card({ be: NaN, m: { mpg: NaN } });
  assert.equal(c.sub, "Cost of this charge. Pick your car to compare it with gas.");
  const withCar = card({ be: NaN });
  assert.equal(withCar.sub, "Cost of this charge. Add your gas price to see if it beats filling up.");
});

test("the cost card needs both a charger price and energy to buy", () => {
  // The split inside arm 1: either one missing and there is no cost to show.
  assert.equal(card({ be: NaN, hasRate: false }).headline, "\u2026");
  assert.equal(card({ be: NaN, session: { kwhFromCharger: 0 } }).headline, "\u2026");
  assert.equal(card({ be: NaN }).headline, "$3.25");
});

test("with nothing priced at all the card prompts for what is missing", () => {
  const c = card({ be: NaN, hasRate: false });
  assert.equal(c.verdict, "close");
  assert.equal(c.headline, "\u2026");
  assert.equal(c.sub, "Start with your gas price or the energy rate. Add both to see which is cheaper.");
  assert.equal(c.detailLine.hidden, true);
  assert.equal(c.timeline.hidden, true);
  const noCar = card({ be: NaN, hasRate: false, m: { mpg: NaN, miPerKwh: NaN } });
  assert.equal(noCar.sub, "Pick your car to start.");
});

test("the empty card points at the current charger pricing editor", () => {
  assert.equal(card({ be: NaN, hasRate: false, rateMode: "tod" }).sub,
    "Start with your gas price or time-of-day rates. Add both to see which is cheaper.");
  assert.equal(card({ be: NaN, hasRate: false, rateMode: "dur" }).sub,
    "Start with your gas price or duration tiers. Add both to see which is cheaper.");
  assert.equal(card({ be: NaN, hasRate: false, rateMode: "flat" }).sub,
    "Start with your gas price or the energy rate. Add both to see which is cheaper.");
});

test("the empty card only mentions charger pricing when the charge can be sized", () => {
  const noSizedCharge = card({ be: NaN, hasRate: false, session: { kwhFromCharger: 0 } });
  assert.equal(noSizedCharge.sub, "Enter your local gas price to see the break-even.");

  const alreadyHasRate = card({ be: NaN, hasRate: true, session: { kwhFromCharger: 0 } });
  assert.equal(alreadyHasRate.sub, "Enter your local gas price to see the break-even.");

  // By-duration with the "Charge for" slider at 0: adding tiers would still buy nothing.
  const durNothingToBuy = card({ be: NaN, hasRate: false, rateMode: "dur", session: { kwhFromCharger: 0 } });
  assert.equal(durNothingToBuy.sub, "Enter your local gas price to see the break-even.");

  // Time of day with nothing to charge: a schedule cannot price a charge that cannot be sized.
  const todNothingToBuy = card({ be: NaN, hasRate: false, rateMode: "tod", session: { kwhFromCharger: 0 } });
  assert.equal(todNothingToBuy.sub, "Enter your local gas price to see the break-even.");
});

// --- Arm 2: no charger price -------------------------------------------------

test("without a charger price the break-even itself is the headline", () => {
  const c = card({ hasRate: false });
  assert.equal(c.verdict, "worth");
  assert.equal(c.headline, "$0.47/kWh");
  assert.equal(c.sub, "Break-even price. Enter the charger's energy rate for a yes/no.");
  assert.equal(c.detailLine.hidden, true);
  assert.equal(c.timeline.hidden, true);
});

test("the break-even card points at the editor the current mode uses", () => {
  assert.equal(card({ hasRate: false, rateMode: "tod" }).sub,
    "Break-even price. Add your time-of-day rates below for a yes/no.");
  assert.equal(card({ hasRate: false, rateMode: "dur" }).sub,
    "Break-even price. Add your duration tiers below for a yes/no.");
  assert.equal(card({ hasRate: false, rateMode: "flat" }).sub,
    "Break-even price. Enter the charger's energy rate for a yes/no.");
});

// --- Arm 3: nothing to charge ------------------------------------------------

test("a target at or below the current charge is a neutral state, not a verdict", () => {
  const c = card({ m: { startPct: 80, targetPct: 80 } });
  assert.equal(c.verdict, "none", "amber here would claim a toss-up nobody calculated");
  assert.equal(c.headline, "\uD83D\uDD0B Nothing to charge");
  assert.equal(c.sub, "Already at your 80% target. Raise \u201cCharge to\u201d to compare.");
  assert.equal(c.detailLine.hidden, true);
  assert.equal(c.timeline.hidden, true);
});

test("a full battery says so instead of naming the target", () => {
  assert.equal(card({ m: { startPct: 100, targetPct: 100 } }).headline, "\uD83D\uDD0B Battery's full");
  assert.equal(card({ m: { startPct: 100, targetPct: 80 } }).headline, "\uD83D\uDD0B Battery's full",
    "a battery past the target is still full");
  assert.equal(card({ m: { startPct: 60, targetPct: 60 } }).headline, "\uD83D\uDD0B Nothing to charge");
});

test("an unknown start or target charge is not treated as nothing to charge", () => {
  assert.equal(card({ m: { startPct: NaN, targetPct: 80 } }).headline, "\u26A1 Charge it");
  assert.equal(card({ m: { startPct: 20, targetPct: NaN } }).headline, "\u26A1 Charge it");
});

test("the arms keep their order: a missing price outranks a full battery", () => {
  const noGas = card({ be: NaN, hasRate: false, m: { startPct: 100, targetPct: 100 } });
  assert.equal(noGas.headline, "\u2026", "arm 3 answered a question arm 1 had already stopped on");
  const noRate = card({ hasRate: false, m: { startPct: 100, targetPct: 100 } });
  assert.equal(noRate.headline, "$0.47/kWh", "arm 3 answered ahead of arm 2");
});

// Start equal to target, as render() would size it: nothing to buy.
const AT_TARGET = () => ({ m: { startPct: 50, targetPct: 50 }, session: { kwhFromCharger: 0, minutes: 0 } });

test("with a rate and nothing to charge, the card says so before a gas price is in", () => {
  // It asked for the gas price, and a gas price could only lead here.
  const c = card({ ...AT_TARGET(), be: NaN, m: { ...AT_TARGET().m, batteryKwh: 10 } });
  assert.equal(c.verdict, "none");
  assert.equal(c.headline, "\uD83D\uDD0B Nothing to charge");
  assert.equal(c.sub, "Already at your 50% target. Raise \u201cCharge to\u201d to see what it costs.",
    "without a gas price, raising the target shows a cost, not a comparison");
  assert.equal(c.detailLine.hidden, true);
  assert.equal(c.timeline.hidden, true);
  assert.equal(card({ be: NaN, m: { startPct: 50, targetPct: 55, batteryKwh: 10 } }).headline, "$3.25",
    "where raising it leads");
});

test("with no battery size, nothing to charge asks for the gas price as well", () => {
  // Raising "Charge to" cannot show a cost here: a charge with no battery size
  // cannot be sized, so it only reaches the gas prompt. With a gas price too,
  // the rate gets a verdict.
  const raised = { m: { startPct: 50, targetPct: 55 }, session: { kwhFromCharger: 0, minutes: 0 }, full: { fullMinutes: 0, kwhFromCharger: 0 } };
  assert.equal(card({ ...raised, be: NaN }).sub, "Enter your local gas price to see the break-even.",
    "where raising it alone leads");
  assert.equal(card(raised).headline, "\u26A1 Charge it", "where raising it and a gas price lead");
  const c = card({ ...AT_TARGET(), be: NaN });
  assert.equal(c.headline, "\uD83D\uDD0B Nothing to charge");
  assert.equal(c.sub, "At your 50% target. Raise \u201cCharge to\u201d and add your gas price to compare.");
});

test("with no charge power, nothing to charge asks for the gas price as well", () => {
  // A power of 0, or a blank one, sizes nothing either.
  for (const drawKw of [0, NaN]) {
    const c = card({ ...AT_TARGET(), be: NaN, m: { ...AT_TARGET().m, batteryKwh: 10 }, drawKw });
    assert.equal(c.sub, "At your 50% target. Raise \u201cCharge to\u201d and add your gas price to compare.",
      `a ${drawKw} kW charge was promised a cost`);
  }
});

test("a full battery, or a gas price, asks the same whether or not the charge can be sized", () => {
  // "Battery's full" asks for nothing, and with a gas price a higher target
  // gets a verdict sized or not, so neither depends on the battery size.
  const atFull = { m: { startPct: 100, targetPct: 100 }, session: { kwhFromCharger: 0, minutes: 0 } };
  assert.deepEqual(card({ ...atFull, be: NaN }), card({ ...atFull, be: NaN, m: { ...atFull.m, batteryKwh: 10 } }));
  assert.equal(card({ ...atFull, be: NaN }).sub, "Already full, so there's nothing to charge.");
  for (const drawKw of [7.2, 0]) {
    assert.equal(card({ ...AT_TARGET(), drawKw }).sub, "Already at your 50% target. Raise \u201cCharge to\u201d to compare.");
  }
});

test("the no-gas nothing-to-charge card is the one arm 3 paints", () => {
  const atFull = { m: { startPct: 100, targetPct: 100 }, session: { kwhFromCharger: 0, minutes: 0 } };
  assert.deepEqual(card({ ...atFull, be: NaN }), card(atFull), "the two arms drifted apart");
  assert.equal(card({ ...atFull, be: NaN }).headline, "\uD83D\uDD0B Battery's full");
  assert.equal(card({ ...AT_TARGET(), be: NaN }).headline, card(AT_TARGET()).headline);
});

test("with no rate, nothing to charge still asks for the gas price", () => {
  // Honest here: the break-even card comes before nothing-to-charge, so a gas
  // price alone delivers what the prompt promises.
  const c = card({ ...AT_TARGET(), be: NaN, hasRate: false });
  assert.equal(c.headline, "\u2026");
  assert.equal(c.sub, "Enter your local gas price to see the break-even.");
  assert.equal(card({ ...AT_TARGET(), hasRate: false }).headline, "$0.47/kWh");
});

test("with no car, nothing to charge still asks for the car", () => {
  const c = card({ ...AT_TARGET(), be: NaN, m: { mpg: NaN, miPerKwh: NaN, startPct: 50, targetPct: 50 } });
  assert.equal(c.sub, "Pick your car to start.");
});

test("with a gas price and nothing to charge, the break-even card asks for a higher target too", () => {
  // It asked for the rate alone "for a yes/no", and a rate alone only leads to
  // "Nothing to charge". The break-even does not depend on the charge, so it stays.
  assert.equal(card(AT_TARGET()).headline, "\uD83D\uDD0B Nothing to charge", "where a rate alone leads");
  for (const [rateMode, sub] of [
    ["flat", "Break-even price. Raise \u201cCharge to\u201d and enter the energy rate for a yes/no."],
    ["tod", "Break-even price. Raise \u201cCharge to\u201d and add time-of-day rates for a yes/no."],
    ["dur", "Break-even price. Raise \u201cCharge to\u201d and add duration tiers for a yes/no."],
  ]) {
    const c = card({ ...AT_TARGET(), hasRate: false, rateMode });
    assert.equal(c.headline, "$0.47/kWh", `${rateMode} lost the break-even`);
    assert.equal(c.sub, sub);
  }
});

test("a full battery's break-even card asks for nothing it cannot use", () => {
  // "Charge to" cannot go past 100%, so there is nothing to raise.
  const full = { m: { startPct: 100, targetPct: 100 }, session: { kwhFromCharger: 0, minutes: 0 }, hasRate: false };
  for (const rateMode of ["flat", "tod", "dur"]) {
    const c = card({ ...full, rateMode });
    assert.equal(c.headline, "$0.47/kWh");
    assert.equal(c.sub, "Break-even price. Already full, so there's nothing to charge.");
  }
});

test("with a target above the start, the break-even card still asks for the rate alone", () => {
  // A rate alone gets a yes/no here, so the prompt was honest and stays.
  const above = { m: { startPct: 50, targetPct: 55 } };
  assert.equal(card(above).headline, "\u26A1 Charge it", "where a rate alone leads");
  assert.equal(card({ ...above, hasRate: false }).sub,
    "Break-even price. Enter the charger's energy rate for a yes/no.");
  assert.equal(card({ ...above, hasRate: false, rateMode: "tod" }).sub,
    "Break-even price. Add your time-of-day rates below for a yes/no.");
  assert.equal(card({ ...above, hasRate: false, rateMode: "dur" }).sub,
    "Break-even price. Add your duration tiers below for a yes/no.");
});

// --- Arm 4: the verdict ------------------------------------------------------

test("a cheap charge reads as a win, priced in gallons", () => {
  const c = card();
  assert.equal(c.verdict, "worth");
  assert.equal(c.headline, "\u26A1 Charge it");
  assert.equal(c.sub, "Like $1.29/gal gas, 68% cheaper");
  assert.deepEqual(c.detailLine, { hidden: false, text: "You pay $0.12/kWh \u00b7 break-even $0.47/kWh" });
  assert.deepEqual(c.timeline, { hidden: false, text: "Est. 1 hr 30 min to 80% at 7.2 kW" });
});

test("the detail line quotes the all-in rate only when there is more in it", () => {
  assert.equal(card({ showEffective: false }).detailLine.text,
    "You pay $0.12/kWh \u00b7 break-even $0.47/kWh");
  assert.equal(card({ showEffective: true, inclNote: " incl. tax and fees" }).detailLine.text,
    "Effective $0.15/kWh incl. tax and fees \u00b7 break-even $0.47/kWh",
    "the fees the effective rate absorbed went unnamed");
});

test("free gas cannot be beaten, whatever the break-even says", () => {
  const c = card({ m: { gasPrice: 0 } });
  assert.equal(c.sub, "Gas is free here, so charging can't win.");
});

test("an expensive charge names the gas price it is really costing you", () => {
  const c = card({ effective: 0.7 });
  assert.equal(c.verdict, "gas");
  assert.equal(c.headline, "\u26FD Use gas");
  assert.equal(c.sub, "Like $6.00/gal gas, 50% pricier");
});

test("past 100% pricier the card multiplies instead, in half steps", () => {
  assert.equal(card({ effective: 1.4 }).sub, "Like $12.00/gal gas, ~3x the price",
    "200% pricier is the kind of percentage nobody reads");
  assert.equal(card({ effective: 7 / 6 }).sub, "Like $10.00/gal gas, ~2.5x the price");
});

test("an absurd rate drops the comparison rather than printing it", () => {
  // Above 100x there is no gas price worth quoting.
  assert.equal(card({ effective: 60 }).sub, "Charging here costs far more than gas.");
});

test("a toss-up says which way it leans, and only when it leans", () => {
  assert.equal(card({ effective: 0.46 }).sub,
    "About the same as gas (~$3.94/gal), leaning cheaper 1%");
  assert.equal(card({ effective: 0.48 }).sub,
    "About the same as gas (~$4.11/gal), leaning pricier 3%");
  assert.equal(card({ effective: 0.4666666666666667 }).sub,
    "About the same as gas (~$4.00/gal)", "a dead heat still leaned 0%");
  assert.equal(card({ effective: 0.46 }).headline, "\u2248 Toss-up");
});

test("a rate we cannot judge is shown as a toss-up, never as a win", () => {
  const c = card({ effective: NaN });
  assert.equal(c.verdict, "close", "an unknown verdict reached the card as an unknown colour");
  assert.equal(c.headline, "\u2248 Toss-up");
});

test("the card prices in liters when the user is not on gallons", () => {
  const c = card({ units: "metric" });
  assert.equal(c.sub, "Like $0.34/L gas, 68% cheaper", "a per-gallon price was labelled per litre");
});

test("the estimate is dropped when it would only measure a charge we advise against", () => {
  assert.deepEqual(card({ effective: 0.7 }).timeline, { hidden: true, text: null },
    "an hour and a half was quoted for a stop the card says to skip");
  assert.deepEqual(card({ session: { minutes: 0 } }).timeline, { hidden: true, text: null });
  assert.deepEqual(card({ session: { minutes: NaN } }).timeline, { hidden: true, text: null });
});

// --- Arm 4: the time-of-day note --------------------------------------------

const SCHEDULE = [{ start: 0, rate: 0.30 }, { start: 1380, rate: 0.10 }];
const TIP = () => ({ min: 30, range: 45, rangeUnit: "mi", equiv: "$2.10", unit: "/gal", pct: 55 });

test("outside the cheap window the card says when the cheap window starts", () => {
  const c = card({ rateMode: "tod", schedule: SCHEDULE, now: 600 });
  assert.deepEqual(c.touNote, {
    hidden: false,
    text: "\u23F0 Cheaper from 11:00 PM: $0.10/kWh (now $0.30)",
  });
});

test("inside the cheap window the card says to go ahead", () => {
  const c = card({ rateMode: "tod", schedule: SCHEDULE, now: 1400 });
  assert.deepEqual(c.touNote, {
    hidden: false,
    text: "\u2705 You're in the cheapest window now ($0.10/kWh)",
  });
});

test("the time-of-day note stands down for a best-value tip, so there is one action", () => {
  const withTip = card({ rateMode: "tod", schedule: SCHEDULE, now: 600, tip: TIP() });
  assert.deepEqual(withTip.touNote, { hidden: true, text: null });
  assert.deepEqual(card({ rateMode: "tod", schedule: [] }).touNote, { hidden: true, text: null });
  assert.deepEqual(card({ rateMode: "flat", schedule: SCHEDULE }).touNote, { hidden: true, text: null });
});

// --- Arm 4: the best-value tip and the worth-limit note ----------------------

test("a best-value tip takes over the headline and the green block", () => {
  const c = card({ tip: TIP(), showBriefly: true });
  assert.equal(c.verdict, "close", "a stop-early steer is not the same as a confident top-off");
  assert.equal(c.headline, "\u26A1 Charge briefly");
  assert.deepEqual(c.worthTip, {
    hidden: false,
    lead: "\uD83D\uDCA1 Best value: charge about 30 min",
    sub: "~45 mi \u00b7 like $2.10/gal gas, 55% cheaper",
  });
  assert.deepEqual(c.timeNote, { hidden: true, text: null }, "two notes answered the same question");
  assert.deepEqual(c.timeline, { hidden: true, text: null });
});

test("a long stop-early charge is partway, not briefly", () => {
  assert.equal(card({ tip: { ...TIP(), min: 60 }, showBriefly: true }).headline, "\u26A1 Charge briefly");
  assert.equal(card({ tip: { ...TIP(), min: 61 }, showBriefly: true }).headline, "\u26A1 Charge partway");
});

test("when even a short charge loses, the card says so instead of a limit", () => {
  const c = card({ fullNotWorth: true, worthLimitMin: 45 });
  assert.deepEqual(c.timeNote, {
    hidden: false,
    text: "\u23F1\uFE0F Even a short charge here costs more than gas.",
  });
  assert.deepEqual(c.worthTip, { hidden: true, lead: null, sub: null });
});

test("the worth limit names the reason the rate stops paying", () => {
  const byTime = card({ worthLimitMin: 45, hasTimeTiers: true });
  assert.equal(byTime.timeNote.text,
    "\u23F1\uFE0F Worth it up to about 45 min of charging (~60%). Longer, and the time fee beats gas.");
  const byTier = card({ worthLimitMin: 45, hasTimeTiers: false });
  assert.equal(byTier.timeNote.text,
    "\u23F1\uFE0F Worth it up to about 45 min of charging (~60%). Longer, and the rate climbs past gas.");
});

test("a worth limit at the end of the charge is no limit at all", () => {
  assert.deepEqual(card({ worthLimitMin: 120, full: { fullMinutes: 120 } }).timeNote, { hidden: true, text: null });
  assert.deepEqual(card({ worthLimitMin: null }).timeNote, { hidden: true, text: null });
  assert.equal(card({ worthLimitMin: 119, full: { fullMinutes: 120 } }).timeNote.hidden, false);
});

// --- "Charge for" at 0 ------------------------------------------------------

// The slider dragged to 0 in by-duration mode, as render() sizes it: a full
// charge buys energy, the selected one buys none, and with no flat rate behind
// it the effective price is unknown.
const AT_ZERO = () => ({
  session: { kwhFromCharger: 0, kwhIntoBattery: 0, minutes: 0, soc: 20, totalCost: 0 },
  full: { worthLimitSoc: 60, fullMinutes: 120, kwhFromCharger: 11.36 },
  effective: NaN,
  showEffective: true,
  rateMode: "dur",
});

test("with Charge for at 0 the card asks for a charge instead of comparing one", () => {
  // It read as a toss-up: "About the same as gas (~-/gal)", "Effective -/kWh".
  const c = card(AT_ZERO());
  assert.equal(c.verdict, "none", "amber would claim a toss-up nobody calculated");
  assert.equal(c.headline, "\u2026");
  assert.equal(c.sub, "Slide \u201cCharge for\u201d up to see what it costs.");
  for (const el of ["detailLine", "timeline", "touNote", "timeNote", "worthTip"]) {
    assert.equal(c[el].hidden, true, `${el} still showed for a charge that buys nothing`);
  }
});

test("Charge for at 0 is not judged on the bare rate either", () => {
  // Flat mode with a time fee falls back to the entered rate, which is finite,
  // so the card read "Charge it" for a charge that buys nothing.
  const c = card({ ...AT_ZERO(), rateMode: "flat", effective: 0.15, showEffective: false, hasTimeTiers: true });
  assert.equal(c.headline, "\u2026");
});

test("without a gas price, Charge for at 0 shows the same card", () => {
  // Not the gas prompt: a gas price alone would only lead to this card.
  assert.deepEqual(card({ ...AT_ZERO(), be: NaN }), card(AT_ZERO()), "the two arms drifted apart");
});

test("with no rate or no car, Charge for at 0 keeps its prompt", () => {
  assert.equal(card({ ...AT_ZERO(), be: NaN, hasRate: false }).sub,
    "Enter your local gas price to see the break-even.");
  assert.equal(card({ ...AT_ZERO(), be: NaN, m: { mpg: NaN, miPerKwh: NaN } }).sub, "Pick your car to start.");
});

test("with a gas price but no rate, Charge for at 0 asks for a longer charge too", () => {
  // It asked for the rate alone "for a yes/no", and a rate alone only leads to
  // the card above. By duration, or with a time fee in the other two modes.
  assert.equal(card(AT_ZERO()).sub, "Slide \u201cCharge for\u201d up to see what it costs.", "where a rate alone leads");
  for (const [rateMode, sub] of [
    ["flat", "Break-even price. Slide \u201cCharge for\u201d up and enter the energy rate for a yes/no."],
    ["tod", "Break-even price. Slide \u201cCharge for\u201d up and add time-of-day rates for a yes/no."],
    ["dur", "Break-even price. Slide \u201cCharge for\u201d up and add duration tiers for a yes/no."],
  ]) {
    const c = card({ ...AT_ZERO(), hasRate: false, rateMode, hasTimeTiers: rateMode !== "dur" });
    assert.equal(c.headline, "$0.47/kWh", `${rateMode} lost the break-even`);
    assert.equal(c.sub, sub);
  }
});

test("a 100% target is not a full battery, and an unsized charge only needs the rate", () => {
  assert.equal(card({ ...AT_ZERO(), hasRate: false, m: { startPct: 20, targetPct: 100 } }).sub,
    "Break-even price. Slide \u201cCharge for\u201d up and add duration tiers for a yes/no.",
    "Charge for at 0 with a 100% target was called full");
  // No battery size: no length buys anything, and the rate alone still gets a verdict.
  const unsized = { session: { kwhFromCharger: 0, minutes: 0 }, full: { fullMinutes: 0, kwhFromCharger: 0 } };
  assert.equal(card({ ...unsized, hasRate: false }).sub, "Break-even price. Enter the charger's energy rate for a yes/no.");
});

test("a charge that cannot be sized is not mistaken for Charge for at 0", () => {
  // No battery size: the full charge buys nothing either, so the verdict on
  // the entered rate stands, and so does the gas prompt before it.
  const unsized = { session: { kwhFromCharger: 0, minutes: 0 }, full: { fullMinutes: 0, kwhFromCharger: 0 } };
  assert.equal(card(unsized).headline, "\u26A1 Charge it");
  assert.equal(card({ ...unsized, be: NaN }).sub, "Enter your local gas price to see the break-even.");
});

test("the Charge for readout says 0 min at 0, not a dash", () => {
  assert.equal(chargeForReadout(0, 20), "0 min (~20%)");
  assert.equal(chargeForReadout(45, 51.6), "45 min (~52%)");
  assert.equal(chargeForReadout(90, 80), "1 hr 30 min (~80%)");
});

// --- The Charger speed row ---------------------------------------------------

const PRESETS = [{ name: "Level 1", kw: 1.4 }, { name: "Level 2", kw: 6.6 }];

test("the Charger speed row names a preset the field matches, and presses it alone", () => {
  assert.deepEqual(speedSummary(6.6, PRESETS), { name: "Level 2", rate: "6.6 kW", pressed: [false, true] });
  assert.deepEqual(speedSummary(1.4, PRESETS), { name: "Level 1", rate: "1.4 kW", pressed: [true, false] });
  // Within presetMatchesKw's reach the preset is lit, so the row says its printed rate.
  assert.deepEqual(speedSummary(6.62, PRESETS), { name: "Level 2", rate: "6.6 kW", pressed: [false, true] });
});

test("the Charger speed row shows any other speed as itself, with no preset pressed", () => {
  assert.deepEqual(speedSummary(7.2, PRESETS), { name: null, rate: "7.2 kW", pressed: [false, false] });
  assert.deepEqual(speedSummary(11, PRESETS), { name: null, rate: "11 kW", pressed: [false, false] });
  assert.deepEqual(speedSummary(3.333, PRESETS), { name: null, rate: "3.33 kW", pressed: [false, false] }, "at the field's own 2 dp");
  assert.deepEqual(speedSummary(50, PRESETS), { name: null, rate: "50 kW", pressed: [false, false] }, "the outlet as typed, not the 22 it is priced at");
  assert.deepEqual(speedSummary(NaN, PRESETS), { name: null, rate: "Not set", pressed: [false, false] }, "a cleared field");
});

// --- The "Charge for" slider -------------------------------------------------

test("a 288.3-minute full charge is called full, with the handle at the far end", () => {
  // The end was rounded up to 289 and the handle to the nearest minute, 288,
  // so a finished charge read "Stopping early" and sat a step short.
  const s = chargeForSlider(288.3, 288.3, true);
  assert.equal(s.note, "Full charge to your target.");
  assert.equal(s.max, 288);
  assert.equal(s.value, s.max, "the handle snapped back a step from the far end");
});

test("a full charge past the half minute rounds the same way at both ends", () => {
  const s = chargeForSlider(288.7, 288.7, true);
  assert.deepEqual([s.max, s.value, s.note], [289, 289, "Full charge to your target."]);
});

test("a charge stopped short says why, in the words of the pricing mode", () => {
  assert.equal(chargeForSlider(288.3, 287, true).note, "Stopping early: less energy, but less time fee.",
    "a minute short of the full charge is still stopping early");
  assert.equal(chargeForSlider(288.3, 120, false).note,
    "Stopping early: less energy, and you skip the pricier later rate.");
  assert.deepEqual([chargeForSlider(288.3, 0, true).value, chargeForSlider(288.3, 120, true).value], [0, 120]);
});

test("a 10-minute full charge ends the track, with the handle at the end", () => {
  // The track never spanned less than 15 minutes, so the handle sat two thirds
  // along, and dragged to the end it snapped back to 10.
  const s = chargeForSlider(10, 10, true);
  assert.equal(s.max, 10, "the track ran past the full charge");
  assert.equal(s.value, s.max, "the handle snapped back from the end");
  assert.equal(s.note, "Full charge to your target.");
  const odd = chargeForSlider(10.3, 10.3, true);
  assert.deepEqual([odd.max, odd.value, odd.note], [10, 10, "Full charge to your target."]);
  assert.equal(chargeForSlider(10, 5, true).note, "Stopping early: less energy, but less time fee.",
    "a short track still prices a shorter charge");
});

test("a full charge under half a minute still gets a track, ending at the full charge", () => {
  // What the old 15-minute floor still did: this charge rounds to 0 minutes,
  // and a track from 0 to 0 has nothing to drag.
  const s = chargeForSlider(0.3, 0.3, true);
  assert.deepEqual([s.max, s.value, s.note], [1, 1, "Full charge to your target."]);
});

test("a hidden Charge for forgets a 0 and starts over", () => {
  // Dragged to 0, then "Charge to" lowered to "Battery now": the card asked to
  // raise it and add a price, and doing both came back to the hidden 0 with
  // "Slide "Charge for" up" instead of a verdict.
  assert.deepEqual(rememberedChargeFor(false, true, 0), { capTouched: false, chargeCapMin: null });
});

test("Charge for keeps a 0 on screen and any longer drag while hidden", () => {
  assert.deepEqual(rememberedChargeFor(true, true, 0), { capTouched: true, chargeCapMin: 0 },
    "the card on screen asks to slide this very 0 up");
  assert.deepEqual(rememberedChargeFor(false, true, 30), { capTouched: true, chargeCapMin: 30 });
  assert.deepEqual(rememberedChargeFor(false, true, 1), { capTouched: true, chargeCapMin: 1 },
    "a minute buys energy, so it is a drag like any other");
  assert.deepEqual(rememberedChargeFor(false, false, null), { capTouched: false, chargeCapMin: null });
});

// --- The shape the applier depends on ---------------------------------------

test("a hidden element asks to keep its text, never to be blanked", () => {
  // Three of the four arms hide these without rewriting them, so the text
  // already on screen survives. "" would wipe it the moment one is shown again.
  for (const [what, c] of Object.entries({
    "the break-even card": card({ hasRate: false }),
    "the nothing-to-charge card": card({ m: { startPct: 80, targetPct: 80 } }),
    "the prompt card": card({ be: NaN, hasRate: false }),
    "the zero-minute card": card(AT_ZERO()),
  })) {
    assert.equal(c.touNote.text, null, `${what} blanked the time-of-day note`);
    assert.equal(c.timeNote.text, null, `${what} blanked the worth-limit note`);
    assert.equal(c.detailLine.text, null, `${what} blanked the detail line`);
    assert.equal(c.timeline.text, null, `${what} blanked the estimate`);
    assert.equal(c.worthTip.lead, null, `${what} blanked the best-value tip`);
    assert.equal(c.worthTip.sub, null, `${what} blanked the best-value tip`);
  }
});

test("every arm answers for every element, with hidden always a boolean", () => {
  // The applier reads all eight unconditionally: an undefined here is a crash
  // or a stale element, not a no-op.
  const arms = {
    "the cost card": card({ be: NaN }),
    "the prompt card": card({ be: NaN, hasRate: false }),
    "the break-even card": card({ hasRate: false }),
    "the nothing-to-charge card": card({ m: { startPct: 80, targetPct: 80 } }),
    "the zero-minute card": card(AT_ZERO()),
    "the verdict card": card(),
    "the stop-early card": card({ tip: TIP(), showBriefly: true }),
  };
  for (const [what, c] of Object.entries(arms)) {
    assert.equal(typeof c.verdict, "string", `${what} has no verdict`);
    assert.equal(typeof c.headline, "string", `${what} has no headline`);
    assert.equal(typeof c.sub, "string", `${what} has no sub`);
    assert.equal(typeof c.showBriefly, "boolean", `${what} lost showBriefly, which the funnel counts on`);
    assert.equal(typeof c.counted, "boolean", `${what} left counted undefined, which the funnel is gated on`);
    for (const el of ["detailLine", "timeline", "touNote", "timeNote"]) {
      assert.equal(typeof c[el].hidden, "boolean", `${what} left ${el}.hidden undefined`);
      assert.ok(c[el].text === null || typeof c[el].text === "string", `${what} gave ${el} a non-string text`);
    }
    assert.equal(typeof c.worthTip.hidden, "boolean", `${what} left worthTip.hidden undefined`);
  }
  assert.equal(arms["the stop-early card"].showBriefly, true);
  assert.equal(arms["the verdict card"].showBriefly, false);
});

test("only a verdict is counted in the funnel", () => {
  // render() sends the verdict events when this says so, so a card that
  // compared nothing must not count as a verdict shown. "Charge for" at 0
  // used to count as a toss-up nobody saw.
  for (const [what, c] of Object.entries({
    "the cost card": card({ be: NaN }),
    "the prompt card": card({ be: NaN, hasRate: false }),
    "the break-even card": card({ hasRate: false }),
    "the nothing-to-charge card": card(AT_TARGET()),
    "the no-gas nothing-to-charge card": card({ ...AT_TARGET(), be: NaN }),
    "the zero-minute card": card(AT_ZERO()),
    "the no-gas zero-minute card": card({ ...AT_ZERO(), be: NaN }),
  })) {
    assert.equal(c.counted, false, `${what} was counted as a verdict`);
  }
  for (const [what, c] of Object.entries({
    "Charge it": card(),
    "Use gas": card({ effective: 0.9 }),
    "Toss-up": card({ effective: 0.47 }),
    "Charge briefly": card({ tip: TIP(), showBriefly: true }),
    "a verdict on the bare rate, with no battery size": card({ session: { kwhFromCharger: 0, minutes: 0 }, full: { fullMinutes: 0, kwhFromCharger: 0 } }),
  })) {
    assert.equal(c.counted, true, `${what} was not counted`);
  }
});

// --- The "For this charge" block -------------------------------------------

const ADVANCED_MODEL = () => ({
  m: { miPerKwh: 3.5, powerKw: 7.2 },
  cur: "$",
  units: "imperial",
  session: { kwhIntoBattery: 10, kwhFromCharger: 11.36, minutes: 90, totalCost: 3.25 },
  effective: 0.15,
  timeFee: 0,
  drawKw: 7.2,
});

const advanced = (over = {}) => {
  const base = ADVANCED_MODEL();
  return advancedFor({
    ...base, ...over,
    m: { ...base.m, ...(over.m || {}) },
    session: { ...base.session, ...(over.session || {}) },
  });
};

test("with nothing entered the advanced block shows dashes and hides optional rows", () => {
  const view = advanced({
    m: { miPerKwh: NaN, powerKw: NaN },
    session: { kwhIntoBattery: NaN, kwhFromCharger: 0, minutes: NaN, totalCost: NaN },
    effective: NaN,
  });
  assert.deepEqual(view.range, { hidden: false, text: "-" });
  assert.deepEqual(view.timeLabel, { hidden: false, text: "Time to charge (est.)" });
  assert.deepEqual(view.time, { hidden: false, text: "-" });
  assert.deepEqual(view.timeFee, { hidden: true, text: null });
  assert.deepEqual(view.total, { hidden: true, text: null });
});

test("a picked car without a charger rate shows range and time but keeps Total hidden", () => {
  const view = advanced({ effective: NaN, session: { totalCost: NaN } });
  assert.equal(view.range.text, "35 mi \u00b7 10.0 kWh");
  assert.equal(view.time.text, "1 hr 30 min");
  assert.equal(view.total.hidden, true);
});

test("a car and rate show Total for this charge as the session total", () => {
  assert.deepEqual(advanced().total, { hidden: false, text: "$3.25" });
});

test("a per-hour fee shows the Time fee row with its amount", () => {
  assert.deepEqual(advanced({ timeFee: 9.6 }).timeFee, { hidden: false, text: "$9.60" });
});

test("a slower onboard charger names its capped charging power", () => {
  const view = advanced({ m: { powerKw: 3.3 }, drawKw: 2.9 });
  assert.equal(view.timeLabel.text, "Time at 2.9 kW (est.)");
  assert.equal(advanced({ m: { powerKw: 2.9 }, drawKw: 2.849 }).timeLabel.text,
    "Time at 2.85 kW (est.)");
});

test("a charger at the cap tolerance keeps the generic time label", () => {
  assert.equal(advanced({ m: { powerKw: 2.9 }, drawKw: 2.85 }).timeLabel.text,
    "Time to charge (est.)");
  assert.equal(advanced({ m: { powerKw: 2.9 }, drawKw: 2.851 }).timeLabel.text,
    "Time to charge (est.)");
});

test("metric and kmL units show distance in kilometers with the matching label", () => {
  assert.equal(advanced({ units: "metric" }).range.text, "56 km \u00b7 10.0 kWh");
  assert.equal(advanced({ units: "kmL" }).range.text, "56 km \u00b7 10.0 kWh");
});

test("a known battery without miPerKwh calls the row energy, not range", () => {
  // The row can only show kWh here, and "Range added" promised a distance.
  const view = advanced({ m: { miPerKwh: NaN } });
  assert.equal(view.range.text, "10.0 kWh");
  assert.deepEqual(view.rangeLabel, { hidden: false, text: "Energy added" });
});

test("the row keeps the range heading when it shows a distance, or nothing", () => {
  assert.deepEqual(advanced().rangeLabel, { hidden: false, text: "Range added" });
  assert.equal(advanced({ units: "metric" }).rangeLabel.text, "Range added");
  // A dash names no unit, so the heading index.html paints is left standing.
  assert.equal(advanced({ m: { miPerKwh: NaN }, session: { kwhIntoBattery: 0 } }).rangeLabel.text, "Range added");
});

test("a non-USD currency flows through every money field", () => {
  const view = advanced({ cur: "EUR", timeFee: 9.6 });
  assert.equal(view.timeFee.text, "EUR9.60");
  assert.equal(view.total.text, "EUR3.25");
});

test("a zero or non-finite duration keeps the generic label and formats its value", () => {
  assert.equal(advanced({ session: { minutes: 0 } }).timeLabel.text, "Time to charge (est.)");
  assert.equal(advanced({ session: { minutes: 0 } }).time.text, "-");
  assert.equal(advanced({ session: { minutes: NaN } }).time.text, "-");
});

test("a target at or below start still shows the advanced charge estimate", () => {
  assert.equal(advanced().time.text, "1 hr 30 min");
  assert.equal(advanced({ session: { kwhIntoBattery: 0 } }).range.text, "-");
});

test("an unknown effective rate hides Total even when energy and cost are present", () => {
  assert.equal(advanced({ effective: NaN }).total.hidden, true);
});

test("no energy from the charger hides Total even when rate and cost are finite", () => {
  assert.equal(advanced({ session: { kwhFromCharger: 0 } }).total.hidden, true);
});

test("an unknown session total hides Total even when rate and energy are present", () => {
  assert.equal(advanced({ session: { totalCost: NaN } }).total.hidden, true);
});

// --- A Flat price left behind changes nothing in the other two modes --------
//
// Baadal asked whether a price filled in one option can interfere once he
// picks another. Energy rate is hidden outside Flat, never cleared, so
// render() still hands its Flat price over in m.yourRate. Every arm Time of
// day and By duration can reach must read the same with it empty or at 0.30.
// The headline pins each row to the arm it is named after.
const MODE_ARMS = {
  "no gas price, a priced charge": ["$3.25", { be: NaN }],
  "no gas price, nothing priced": ["\u2026", { be: NaN, hasRate: false, effective: NaN }],
  "no gas price, nothing to charge": ["\uD83D\uDD0B Nothing to charge", { ...AT_TARGET(), be: NaN }],
  "no gas price, Charge for at 0": ["\u2026", { ...AT_ZERO(), be: NaN }],
  "a gas price, nothing priced": ["$0.47/kWh", { hasRate: false, effective: NaN }],
  "a gas price, a win": ["\u26A1 Charge it", {}],
  "a gas price, a loss": ["\u26FD Use gas", { effective: 0.9 }],
  "a gas price, a toss-up": ["\u2248 Toss-up", { effective: 0.46 }],
  "a gas price, a best-value tip": ["\u26A1 Charge briefly", { tip: TIP(), showBriefly: true }],
  "a gas price, a worth limit": ["\u26A1 Charge it", { worthLimitMin: 45 }],
  "a gas price, even a short charge loses": ["\u26FD Use gas", { effective: 0.9, fullNotWorth: true }],
  "a gas price, no battery size": ["\u26A1 Charge it", { session: { kwhFromCharger: 0, kwhIntoBattery: 0, minutes: NaN, totalCost: 0 }, full: { fullMinutes: 0, kwhFromCharger: 0 } }],
  "a gas price, nothing to charge": ["\uD83D\uDD0B Nothing to charge", AT_TARGET()],
  "a gas price, a full battery": ["\uD83D\uDD0B Battery's full", { m: { startPct: 100, targetPct: 100 }, session: { kwhFromCharger: 0, minutes: 0 } }],
  "a gas price, Charge for at 0": ["\u2026", AT_ZERO()],
};

// As render() builds it with no fees (assets.test.mjs runs its rule): the
// effective rate shows outside Flat, and Time of day hands over its schedule.
const inMode = (rateMode, over, yourRate) => card({
  ...over, rateMode, showEffective: rateMode !== "flat", schedule: rateMode === "tod" ? SCHEDULE : null,
  m: { ...over.m, yourRate },
});

test("the Flat price reaches the card on Flat, so the two below can see a leak", () => {
  assert.notDeepEqual(inMode("flat", {}, 0.3), inMode("flat", {}, NaN), "m.yourRate never reached cardFor through inMode(), so the tests below prove nothing");
});

for (const [rateMode, name] of [["tod", "Time of day"], ["dur", "By duration"]]) {
  test(`on ${name}, every arm reads the same whatever Flat's Energy rate holds`, () => {
    for (const [arm, [headline, over]] of Object.entries(MODE_ARMS)) {
      const left = inMode(rateMode, over, 0.3);
      assert.equal(left.headline, headline, `${arm} is no longer the arm it is named after`);
      assert.deepEqual(left, inMode(rateMode, over, NaN), `${arm}: the Flat price left in Energy rate changed the ${name} card`);
    }
  });
}

// Each arm with the row that pins it there, read with Energy rate empty.
const ADVANCED_ARMS = {
  "a priced charge": [{}, "total", "$3.25"],
  "a time fee": [{ timeFee: 9.6 }, "timeFee", "$9.60"],
  "nothing priced": [{ effective: NaN }, "total", null],
  "no battery size": [{ session: { kwhIntoBattery: 0, kwhFromCharger: 0, minutes: NaN, totalCost: 0 } }, "range", "-"],
  "power capped by the car": [{ m: { powerKw: 11 }, drawKw: 7.2 }, "timeLabel", "Time at 7.2 kW (est.)"],
  "no mi/kWh, so Energy added": [{ m: { miPerKwh: NaN } }, "rangeLabel", "Energy added"],
};

test("the For this charge block reads the same whatever Flat's Energy rate holds", () => {
  for (const [arm, [over, row, text]] of Object.entries(ADVANCED_ARMS)) {
    const at = (yourRate) => advanced({ ...over, m: { ...over.m, yourRate } });
    assert.equal(at(NaN)[row].text, text, `${arm} is no longer the arm it is named after`);
    assert.deepEqual(at(0.3), at(NaN), `${arm}: the Flat price left in Energy rate changed For this charge`);
  }
});

