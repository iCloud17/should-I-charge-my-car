// cardUi.js - the pure rules behind the result card: which of the four states
// it is in, every string it paints, what the effective rate says it includes,
// how a clock time reads, and how a number is trimmed for display.
//
// Split out of main.js for the reason everything else in this project is split
// out: a rule a test cannot import is a rule nothing holds. main.js touches the
// DOM at load, so anything left in it can only be scanned as text. Everything
// here takes values and returns values, touches no DOM, and is exercised in
// test/cardUi.test.mjs.

import { verdict, rateAtTime, cheapestPeriod } from "./calc.js";
import { money, formatDuration } from "./ui.js";
import { gasPriceForDisplay, kmFromMiles, labels } from "./units.js";
import { presetMatchesKw } from "./cars.js";
const BRIEF_MAX_MIN = 60;

// What the effective rate includes beyond the entered price. Sales tax is not a
// fee, so it is named as itself; "fees" stays plural because it covers the
// per-session and per-hour ones together.
export function inclusionNote(hasTax, hasFee) {
  if (hasTax && hasFee) return " incl. tax and fees";
  if (hasTax) return " incl. tax";
  if (hasFee) return " incl. fees";
  return "";
}

// The price per kWh the card judges. A sized charge uses its all-in average
// (energy, fees and tax). With no battery size there is no kWh to spread the
// session and hourly fees over, so it is the energy rate the charge starts
// on, plus tax, which is per kWh either way. That rate comes from the active
// mode: outside Flat, Energy rate is hidden and can hold an old price.
export function effectivePerKwh({ hasRate, kwh, session, rateOf, startClockMin, taxRate }) {
  if (!hasRate) return NaN;
  return kwh > 0 ? session.effectivePerKwh : rateOf(startClockMin, 0) * (1 + taxRate);
}

export function numText(n, d) {
  if (!Number.isFinite(n)) return "";
  const f = Math.pow(10, d);
  return String(Math.round(n * f) / f);
}

// A dash for an unknown time, the same mark money() leaves in the sentence
// this is painted into.
export function fmtClock(min) {
  if (!Number.isFinite(min)) return "-";
  min = ((Math.round(min) % 1440) + 1440) % 1440;
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

// --- The result card as a value ---------------------------------------------
//
// cardFor is the four-arm decision chain of render() with the DOM taken out:
// same order, same conditions, same strings. Order matters. No gas price (or no
// car) first, then no charger price, then nothing to charge (the battery is at
// the target, or "Charge for" is at 0), then the real verdict. Inside the first
// arm, a priced and sized charge can still show its cost without a gas price,
// and a priced charge with nothing to charge says so there, because a gas price
// could only lead to that card.
//
// counted is true from the verdict arm only. The analytics funnel counts the
// verdicts shown, and render() gates those events on this flag rather than
// working out a second time which arm answered.
//
// null text means "leave what is already there". Three of the four arms hide an
// element without rewriting it, so its previous text survives behind
// [hidden] { display: none }. Returning "" instead would blank those nodes,
// which is a visible change the moment one is shown again.
const hiddenLine = () => ({ hidden: true, text: null });
const hiddenTip = () => ({ hidden: true, lead: null, sub: null });

function missingGasOrChargerPrompt(rateMode) {
  if (rateMode === "tod") {
    return "Start with your gas price or time-of-day rates. Add both to see which is cheaper.";
  }
  if (rateMode === "dur") {
    return "Start with your gas price or duration tiers. Add both to see which is cheaper.";
  }
  return "Start with your gas price or the energy rate. Add both to see which is cheaper.";
}

// Whether the "For this charge" row can turn the energy added into a distance.
const hasDistance = (miPerKwh) => Number.isFinite(miPerKwh) && miPerKwh > 0;

function rangeText(kwhIn, miPerKwh, units) {
  const kwhStr = `${kwhIn.toFixed(1)} kWh`;
  if (hasDistance(miPerKwh)) {
    const dist = miPerKwh * kwhIn;
    const distDisp = (units === "metric" || units === "kmL") ? kmFromMiles(dist) : dist;
    return `${Math.round(distDisp)} ${labels(units).distance} \u00b7 ${kwhStr}`;
  }
  return kwhStr;
}

const nothingToCharge = (m) =>
  Number.isFinite(m.startPct) && Number.isFinite(m.targetPct) && !(m.targetPct > m.startPct);
const batteryFull = (m) => m.targetPct >= 100 || m.startPct >= 100;
// Whether a charge to a higher target could be sized at all: without a battery
// size and a charge power there is no energy or time to put a cost on.
const canSizeCharge = (m, drawKw) => m.batteryKwh > 0 && drawKw > 0;

// Battery is already at (or above) the charge target - there's nothing to
// charge, so a gas/charge verdict would be misleading. Show a neutral state.
// Built here once because the gas and no-gas arms both return it. Without a
// gas price, raising the target can only show a cost, so the sub does not
// promise a comparison there. And when that charge cannot be sized it shows no
// cost either, so the sub asks for the gas price as well, which together with
// a higher target gets a verdict on the rate alone.
function nothingToChargeCard(m, hasGas, showBriefly, canSize) {
  const atFull = batteryFull(m);
  return {
    verdict: "none",
    headline: atFull ? "\uD83D\uDD0B Battery's full" : "\uD83D\uDD0B Nothing to charge",
    sub: atFull
      ? "Already full, so there's nothing to charge."
      : !hasGas && !canSize
        ? `At your ${Math.round(m.targetPct)}% target. Raise \u201cCharge to\u201d and add your gas price to compare.`
        : `Already at your ${Math.round(m.targetPct)}% target. Raise \u201cCharge to\u201d ${hasGas ? "to compare" : "to see what it costs"}.`,
    detailLine: hiddenLine(),
    timeline: hiddenLine(),
    touNote: hiddenLine(),
    timeNote: hiddenLine(),
    worthTip: hiddenTip(),
    showBriefly,
    counted: false,
  };
}

// "Charge for" is at 0: a full charge would buy energy, but the one selected
// buys none. Not the same as a charge that cannot be sized at all (no battery
// size), where the full charge buys nothing either and the entered rate still
// gets a verdict.
const buysNoEnergy = (session, full) =>
  full.kwhFromCharger > 0 && !(session.kwhFromCharger > 0);

// The empty state's ellipsis, in the muted colour because nothing was
// compared. Both arms return it, so it is built here once.
function noChargeSelectedCard(showBriefly) {
  return {
    verdict: "none",
    headline: "\u2026",
    sub: "Slide \u201cCharge for\u201d up to see what it costs.",
    detailLine: hiddenLine(),
    timeline: hiddenLine(),
    touNote: hiddenLine(),
    timeNote: hiddenLine(),
    worthTip: hiddenTip(),
    showBriefly,
    counted: false,
  };
}

// Whether the selected charge would buy energy once priced: the target is above
// the start and "Charge for" is above 0. A charge with no battery size is not
// ruled out, because the entered rate alone still gets a verdict.
const selectionBuysEnergy = (m, session, full) => !nothingToCharge(m) && !buysNoEnergy(session, full);

// The break-even does not depend on the charge, so it heads the card whatever
// is selected. The sub names what is still missing for a yes/no: the charger's
// price, plus "Charge to" or "Charge for" when the selected charge would buy
// nothing once priced. A full battery has nothing to raise, so it asks for
// nothing.
function breakEvenSub(m, session, full, rateMode) {
  if (selectionBuysEnergy(m, session, full)) {
    if (rateMode === "tod") return "Break-even price. Add your time-of-day rates below for a yes/no.";
    if (rateMode === "dur") return "Break-even price. Add your duration tiers below for a yes/no.";
    return "Break-even price. Enter the charger's energy rate for a yes/no.";
  }
  if (nothingToCharge(m) && batteryFull(m)) return "Break-even price. Already full, so there's nothing to charge.";
  const longer = nothingToCharge(m) ? "Raise \u201cCharge to\u201d" : "Slide \u201cCharge for\u201d up";
  const price = rateMode === "tod" ? "add time-of-day rates" : rateMode === "dur" ? "add duration tiers" : "enter the energy rate";
  return `Break-even price. ${longer} and ${price} for a yes/no.`;
}

export function cardFor(model) {
  const {
    m, be, cur, units, hasRate, session, full, drawKw,
    effective, showEffective, inclNote, rateMode, schedule, hasTimeTiers,
    worthLimitMin, fullNotWorth, tip, showBriefly, now,
  } = model;

  if (!Number.isFinite(be)) {
    const haveCar = Number.isFinite(m.mpg) && Number.isFinite(m.miPerKwh);
    const chargeIsSized = session.kwhFromCharger > 0;
    if (haveCar && hasRate && nothingToCharge(m)) return nothingToChargeCard(m, false, showBriefly, canSizeCharge(m, drawKw));
    if (haveCar && hasRate && buysNoEnergy(session, full)) return noChargeSelectedCard(showBriefly);
    if (hasRate && chargeIsSized) {
      // No gas price means no verdict, but the cost of the stop never needed one.
      return {
        verdict: "none",
        headline: money(session.totalCost, cur),
        sub: haveCar
          ? "Cost of this charge. Add your gas price to see if it beats filling up."
          : "Cost of this charge. Pick your car to compare it with gas.",
        detailLine: {
          hidden: false,
          text: showEffective
            ? `Effective ${money(effective, cur)}/kWh${inclNote}`
            : `You pay ${money(m.yourRate, cur)}/kWh`,
        },
        timeline: Number.isFinite(session.minutes) && session.minutes > 0
          ? { hidden: false, text: `Est. ${formatDuration(session.minutes)} to ${Math.round(session.soc)}% at ${numText(drawKw, 2)} kW` }
          : hiddenLine(),
        touNote: hiddenLine(),
        timeNote: hiddenLine(),
        worthTip: hiddenTip(),
        showBriefly,
        counted: false,
      };
    }
    return {
      verdict: "close",
      headline: "\u2026",
      sub: haveCar
        ? !hasRate && chargeIsSized
          ? missingGasOrChargerPrompt(rateMode)
          : "Enter your local gas price to see the break-even."
        : "Pick your car to start.",
      detailLine: hiddenLine(),
      timeline: hiddenLine(),
      touNote: hiddenLine(),
      timeNote: hiddenLine(),
      worthTip: hiddenTip(),
      showBriefly,
      counted: false,
    };
  }

  if (!hasRate) {
    // No charger price yet - the break-even IS the headline answer.
    return {
      verdict: "worth",
      headline: `${money(be, cur)}/kWh`,
      sub: breakEvenSub(m, session, full, rateMode),
      detailLine: hiddenLine(),
      timeline: hiddenLine(),
      touNote: hiddenLine(),
      timeNote: hiddenLine(),
      worthTip: hiddenTip(),
      showBriefly,
      counted: false,
    };
  }

  if (nothingToCharge(m)) return nothingToChargeCard(m, true, showBriefly);
  if (buysNoEnergy(session, full)) return noChargeSelectedCard(showBriefly);

  const v = verdict(effective, be);

  // Layman framing: the gas price that would cost the same per mile, plus how
  // much cheaper/pricier charging is per mile. Everyone intuits gas prices.
  const gasPerMile = m.gasPrice / m.mpg;
  const elecPerMile = effective / m.miPerKwh;
  const equivGas = (effective * m.mpg) / m.miPerKwh; // canonical $/gallon
  const equivDisp = gasPriceForDisplay(equivGas, units);
  const gasUnit = units === "imperial" ? "/gal" : "/L";
  const pct = gasPerMile > 0 ? Math.round((Math.abs(gasPerMile - elecPerMile) / gasPerMile) * 100) : 0;
  // "Pricier" as a percentage reads as confusing once it hits 100% (2x),
  // so at/above 100% we switch to a rounded multiplier ("~2x", "~2.5x",
  // "~3x") in 0.5 steps; under 100% the percentage is clear, so keep it.
  // Gate on the rounded pct (not mult >= 2) so floating-point values a hair
  // under 2x (e.g. 1.9999) still show "~2x" instead of "100% pricier".
  const mult = gasPerMile > 0 ? elecPerMile / gasPerMile : NaN;
  const pricier = pct >= 100
    ? `~${Math.round(mult * 2) / 2}x the price`
    : `${pct}% pricier`;

  // Time-of-day suggestion based on the current clock time. Suppressed when a
  // best-value tip is showing, so the card gives one clear action, not two.
  let touNote = hiddenLine();
  if (rateMode === "tod" && schedule && schedule.length && !tip) {
    const nowRate = rateAtTime(schedule, now);
    const cheap = cheapestPeriod(schedule);
    touNote = {
      hidden: false,
      text: cheap && nowRate > cheap.rate + 1e-9
        ? `\u23F0 Cheaper from ${fmtClock(cheap.start)}: ${money(cheap.rate, cur)}/kWh (now ${money(nowRate, cur)})`
        : `\u2705 You're in the cheapest window now (${money(nowRate, cur)}/kWh)`,
    };
  }

  // Best-value tip: when a shorter charge is the smart move (rising duration
  // tiers, or a per-hour time fee whose $/kWh bottoms out below 100%), surface
  // the sweet spot in a distinct green block (miles + saving). Otherwise fall
  // back to the plain worth-limit note or hide it. The "Charge for" slider
  // answers "how far can I go."
  let timeNote = hiddenLine();
  let worthTip = hiddenTip();
  if (tip) {
    worthTip = {
      hidden: false,
      lead: `\uD83D\uDCA1 Best value: charge about ${formatDuration(tip.min)}`,
      sub: `~${tip.range} ${tip.rangeUnit} \u00b7 like ${tip.equiv}${tip.unit} gas, ${tip.pct}% cheaper`,
    };
  } else if (fullNotWorth) {
    timeNote = { hidden: false, text: `\u23F1\uFE0F Even a short charge here costs more than gas.` };
  } else if (worthLimitMin != null && worthLimitMin < full.fullMinutes - 0.5) {
    const why = hasTimeTiers ? "the time fee beats gas" : "the rate climbs past gas";
    timeNote = { hidden: false, text: `\u23F1\uFE0F Worth it up to about ${formatDuration(worthLimitMin)} of charging (~${Math.round(full.worthLimitSoc)}%). Longer, and ${why}.` };
  }

  return {
    verdict: showBriefly ? "close" : (v === "unknown" ? "close" : v),
    // "Briefly" for a genuinely short stop, "partway" once it runs long.
    headline: showBriefly
      ? (tip.min <= BRIEF_MAX_MIN ? "\u26A1 Charge briefly" : "\u26A1 Charge partway")
      : v === "worth" ? "\u26A1 Charge it" : v === "gas" ? "\u26FD Use gas" : "\u2248 Toss-up",
    // The sub always describes the CURRENT selection (updates live with the
    // slider), so it never disagrees with the price shown for it just below.
    sub: !(m.gasPrice > 0)
      ? "Gas is free here, so charging can't win."
      : v === "worth"
      ? `Like ${money(equivDisp, cur)}${gasUnit} gas, ${pct}% cheaper`
      : v === "gas"
        ? (mult > 100
            ? "Charging here costs far more than gas."
            : `Like ${money(equivDisp, cur)}${gasUnit} gas, ${pricier}`)
        : pct > 0
          ? `About the same as gas (~${money(equivDisp, cur)}${gasUnit}), leaning ${elecPerMile < gasPerMile ? "cheaper" : "pricier"} ${pct}%`
          : `About the same as gas (~${money(equivDisp, cur)}${gasUnit})`,
    detailLine: {
      hidden: false,
      text: showEffective
        ? `Effective ${money(effective, cur)}/kWh${inclNote} \u00b7 break-even ${money(be, cur)}/kWh`
        : `You pay ${money(m.yourRate, cur)}/kWh \u00b7 break-even ${money(be, cur)}/kWh`,
    },
    // "How long" at a glance, using your saved battery / power / charge target.
    timeline: !showBriefly && v !== "gas" && Number.isFinite(session.minutes) && session.minutes > 0
      ? { hidden: false, text: `Est. ${formatDuration(session.minutes)} to ${Math.round(session.soc)}% at ${numText(drawKw, 2)} kW` }
      : hiddenLine(),
    touNote,
    timeNote,
    worthTip,
    showBriefly,
    counted: true,
  };
}

export function advancedFor(model) {
  const { m, cur, units, session, effective, timeFee, drawKw } = model;

  const kwhIn = session.kwhIntoBattery;
  const hasKwh = Number.isFinite(kwhIn) && kwhIn > 0;
  const range = hasKwh ? rangeText(kwhIn, m.miPerKwh, units) : "-";
  const capped = Number.isFinite(drawKw) && Number.isFinite(m.powerKw) && drawKw < m.powerKw - 0.05;
  const hasTime = Number.isFinite(session.minutes) && session.minutes > 0;
  const timeFeeRow = timeFee > 0
    ? { hidden: false, text: money(timeFee, cur) }
    : { hidden: true, text: null };
  const totalRow = Number.isFinite(effective) && session.kwhFromCharger > 0 && Number.isFinite(session.totalCost)
    ? { hidden: false, text: money(session.totalCost, cur) }
    : { hidden: true, text: null };

  return {
    // Without a mi/kWh figure the row can only show energy, so it is not
    // called range. A dash names no unit, so the default heading stands.
    rangeLabel: { hidden: false, text: hasKwh && !hasDistance(m.miPerKwh) ? "Energy added" : "Range added" },
    range: { hidden: false, text: range },
    timeLabel: {
      hidden: false,
      text: capped && hasTime ? `Time at ${numText(drawKw, 2)} kW (est.)` : "Time to charge (est.)",
    },
    time: { hidden: false, text: formatDuration(session.minutes) },
    timeFee: timeFeeRow,
    total: totalRow,
  };
}

// The "Charge for" readout. formatDuration writes "-" when there is no
// estimate, but a handle dragged to 0 is a known zero.
export function chargeForReadout(minutes, soc) {
  return `${minutes === 0 ? "0 min" : formatDuration(minutes)} (~${Math.round(soc)}%)`;
}

// The Charger speed row's value and which preset is pressed, from one match:
// a preset the field matches by its name and printed rate ("Level 2",
// "6.6 kW"), any other number as itself ("7.2 kW"), a blank as "Not set". So
// the row, the highlight and aria-pressed cannot disagree. `presets` is
// [{ name, kw }] in page order.
export function speedSummary(fieldKw, presets) {
  const pressed = presets.map((p) => presetMatchesKw(fieldKw, p.kw));
  const on = presets[pressed.indexOf(true)];
  if (on) return { name: on.name, rate: `${numText(on.kw, 2)} kW`, pressed };
  return { name: null, rate: Number.isFinite(fieldKw) ? `${numText(fieldKw, 2)} kW` : "Not set", pressed };
}

// Where the "Charge for" handle sits and what the note under it says, both
// decided on one rounding of the full charge, so a finished charge cannot read
// as a partial one. The track ends at the full charge, so there is nothing past
// it to drag to. It spans at least a minute, so a full charge under half a
// minute still gets a track, with the handle at its end.
export function chargeForSlider(fullChargeMin, curMin, hasTimeFee) {
  const max = Math.max(1, Math.round(fullChargeMin));
  const value = curMin >= fullChargeMin ? max : Math.max(0, Math.min(max, Math.round(curMin)));
  return {
    max,
    value,
    note: value >= max
      ? "Full charge to your target."
      : hasTimeFee
        ? "Stopping early: less energy, but less time fee."
        : "Stopping early: less energy, and you skip the pricier later rate.",
  };
}

// What "Charge for" remembers after a render. A shown slider keeps what was
// dragged. A hidden one forgets a length that buys no energy (0), so it cannot
// come back with the slider and override what the card asked for: it starts
// over as if never dragged. A dragged length above 0 is kept, as before.
export function rememberedChargeFor(shown, capTouched, chargeCapMin) {
  if (!shown && capTouched && !(chargeCapMin > 0)) return { capTouched: false, chargeCapMin: null };
  return { capTouched, chargeCapMin };
}
