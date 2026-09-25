// cardUi.test.mjs - behavior tests for the result card's pure rules.
// Run with:  node --test
//
// These three were untestable while they lived in main.js, which touches the
// DOM at load: inclusionNote could only be lifted out of the source text with
// new Function, and numText and fmtClock were not covered at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inclusionNote, numText, fmtClock, cardFor, advancedFor } from "../js/cardUi.js";

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

test("fmtClock has no non-finite gate, unlike numText", () => {
  // Recorded, not endorsed: a NaN minute reaches the card as text.
  assert.equal(fmtClock(NaN), "NaN:NaN PM");
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
  assert.equal(c.sub, "Enter your local gas price to see the break-even.");
  assert.equal(c.detailLine.hidden, true);
  assert.equal(c.timeline.hidden, true);
  const noCar = card({ be: NaN, hasRate: false, m: { mpg: NaN, miPerKwh: NaN } });
  assert.equal(noCar.sub, "Pick your car to start.");
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

// --- The shape the applier depends on ---------------------------------------

test("a hidden element asks to keep its text, never to be blanked", () => {
  // Three of the four arms hide these without rewriting them, so the text
  // already on screen survives. "" would wipe it the moment one is shown again.
  for (const [what, c] of Object.entries({
    "the break-even card": card({ hasRate: false }),
    "the nothing-to-charge card": card({ m: { startPct: 80, targetPct: 80 } }),
    "the prompt card": card({ be: NaN, hasRate: false }),
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
    "the verdict card": card(),
    "the stop-early card": card({ tip: TIP(), showBriefly: true }),
  };
  for (const [what, c] of Object.entries(arms)) {
    assert.equal(typeof c.verdict, "string", `${what} has no verdict`);
    assert.equal(typeof c.headline, "string", `${what} has no headline`);
    assert.equal(typeof c.sub, "string", `${what} has no sub`);
    assert.equal(typeof c.showBriefly, "boolean", `${what} lost showBriefly, which the funnel counts on`);
    for (const el of ["detailLine", "timeline", "touNote", "timeNote"]) {
      assert.equal(typeof c[el].hidden, "boolean", `${what} left ${el}.hidden undefined`);
      assert.ok(c[el].text === null || typeof c[el].text === "string", `${what} gave ${el} a non-string text`);
    }
    assert.equal(typeof c.worthTip.hidden, "boolean", `${what} left worthTip.hidden undefined`);
  }
  assert.equal(arms["the stop-early card"].showBriefly, true);
  assert.equal(arms["the verdict card"].showBriefly, false);
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

test("a known battery without miPerKwh preserves the bare-kWh range bug", () => {
  assert.equal(advanced({ m: { miPerKwh: NaN } }).range.text, "10.0 kWh");
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

