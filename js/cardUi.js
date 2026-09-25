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

export function numText(n, d) {
  if (!Number.isFinite(n)) return "";
  const f = Math.pow(10, d);
  return String(Math.round(n * f) / f);
}

export function fmtClock(min) {
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
// car) first, then no charger price, then nothing to charge, then the real
// verdict.
//
// null text means "leave what is already there". Three of the four arms hide an
// element without rewriting it, so its previous text survives behind
// [hidden] { display: none }. Returning "" instead would blank those nodes,
// which is a visible change the moment one is shown again.
const hiddenLine = () => ({ hidden: true, text: null });
const hiddenTip = () => ({ hidden: true, lead: null, sub: null });

function rangeText(kwhIn, miPerKwh, units) {
  const kwhStr = `${kwhIn.toFixed(1)} kWh`;
  if (Number.isFinite(miPerKwh) && miPerKwh > 0) {
    const dist = miPerKwh * kwhIn;
    const distDisp = (units === "metric" || units === "kmL") ? kmFromMiles(dist) : dist;
    return `${Math.round(distDisp)} ${labels(units).distance} \u00b7 ${kwhStr}`;
  }
  return kwhStr;
}

export function cardFor(model) {
  const {
    m, be, cur, units, hasRate, session, full, drawKw,
    effective, showEffective, inclNote, rateMode, schedule, hasTimeTiers,
    worthLimitMin, fullNotWorth, tip, showBriefly, now,
  } = model;

  if (!Number.isFinite(be)) {
    const haveCar = Number.isFinite(m.mpg) && Number.isFinite(m.miPerKwh);
    if (hasRate && session.kwhFromCharger > 0) {
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
      };
    }
    return {
      verdict: "close",
      headline: "\u2026",
      sub: haveCar
        ? "Enter your local gas price to see the break-even."
        : "Pick your car to start.",
      detailLine: hiddenLine(),
      timeline: hiddenLine(),
      touNote: hiddenLine(),
      timeNote: hiddenLine(),
      worthTip: hiddenTip(),
      showBriefly,
    };
  }

  if (!hasRate) {
    // No charger price yet - the break-even IS the headline answer.
    return {
      verdict: "worth",
      headline: `${money(be, cur)}/kWh`,
      sub: rateMode === "tod"
        ? "Break-even price. Add your time-of-day rates below for a yes/no."
        : rateMode === "dur"
          ? "Break-even price. Add your duration tiers below for a yes/no."
          : "Break-even price. Enter the charger's energy rate for a yes/no.",
      detailLine: hiddenLine(),
      timeline: hiddenLine(),
      touNote: hiddenLine(),
      timeNote: hiddenLine(),
      worthTip: hiddenTip(),
      showBriefly,
    };
  }

  if (Number.isFinite(m.startPct) && Number.isFinite(m.targetPct) && !(m.targetPct > m.startPct)) {
    // Battery is already at (or above) the charge target - there's nothing to
    // charge, so a gas/charge verdict would be misleading. Show a neutral state.
    const atFull = m.targetPct >= 100 || m.startPct >= 100;
    return {
      verdict: "none",
      headline: atFull ? "\uD83D\uDD0B Battery's full" : "\uD83D\uDD0B Nothing to charge",
      sub: atFull
        ? "Already full, so there's nothing to charge."
        : `Already at your ${Math.round(m.targetPct)}% target. Raise \u201cCharge to\u201d to compare.`,
      detailLine: hiddenLine(),
      timeline: hiddenLine(),
      touNote: hiddenLine(),
      timeNote: hiddenLine(),
      worthTip: hiddenTip(),
      showBriefly,
    };
  }

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
  };
}

export function advancedFor(model) {
  const { m, cur, units, session, effective, timeFee, drawKw } = model;

  const kwhIn = session.kwhIntoBattery;
  const range = Number.isFinite(kwhIn) && kwhIn > 0
    ? rangeText(kwhIn, m.miPerKwh, units)
    : "-";
  const capped = Number.isFinite(drawKw) && Number.isFinite(m.powerKw) && drawKw < m.powerKw - 0.05;
  const hasTime = Number.isFinite(session.minutes) && session.minutes > 0;
  const timeFeeRow = timeFee > 0
    ? { hidden: false, text: money(timeFee, cur) }
    : { hidden: true, text: null };
  const totalRow = Number.isFinite(effective) && session.kwhFromCharger > 0 && Number.isFinite(session.totalCost)
    ? { hidden: false, text: money(session.totalCost, cur) }
    : { hidden: true, text: null };

  return {
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
