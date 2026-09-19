// main.js - wire inputs → calc → render. Persist to localStorage.

import { breakevenKwhPrice, chargeCurve, verdict, rateAtTime, rateAtElapsed, cheapestPeriod } from "./calc.js";
import * as U from "./units.js";
import {
  loadPrefs, savePrefs, resetPrefs,
  applyCarEdit, applyCarSelection, persistableFrom, CAR_EDIT_FIELDS,
} from "./storage.js";
import {
  loadCars, getCar, getCars, carLabel, maxLabelLength,
  chargeDrawKw, presetMatchesKw,
} from "./cars.js";
import { $, parseNum, money, formatDuration, escapeHtml, nextOptionIndex, enterAction } from "./ui.js";
import { applyTheme, nextThemeMode, themeLabel } from "./theme.js";
import { track, trackWhenReady } from "./analytics.js";
import {
  addTouRow, addDurRow, addTimeFeeRow, addTaxRow,
  readSchedule, readDurationTiers, readTimeFee, readTaxRate,
} from "./editorRows.js";
import { createDropdown } from "./dropdown.js";

let prefs = loadPrefs();
let rateMode = "flat"; // "flat" | "tod" | "dur" (volatile - never persisted)
let chargeCapMin = null; // "charge for" slider value in minutes (volatile)
let capTouched = false;  // has the user dragged the "charge for" slider?
let currencyDropdown = null, unitDropdown = null; // built in attachEvents()

// Above this, a stop-early recommendation reads as "partway", not "briefly".
const BRIEF_MAX_MIN = 60;

// --- Read canonical model values from the DOM (converting from display units) ---
function readInputs() {
  const system = prefs.units;
  const gasDisplay = parseNum($("gasPrice").value);
  const rateDisplay = parseNum($("yourRate").value);
  const mpgDisplay = parseNum($("mpg").value);
  const effDisplay = parseNum($("miPerKwh").value);

  return {
    gasPrice: U.gasPriceToCanonical(gasDisplay, system),
    yourRate: rateDisplay, // $/kWh is universal
    mpg: U.economyToCanonical(mpgDisplay, system),
    miPerKwh: U.efficiencyToCanonical(effDisplay, system),
    batteryKwh: parseNum($("batteryKwh").value),
    sessionFee: parseNum($("sessionFee").value) || 0,
    powerKw: parseNum($("powerKw").value),
    startPct: parseNum($("startPct").value),
    targetPct: parseNum($("targetPct").value),
  };
}

// Persist a render pass. `m` must carry the RAW outlet power: persistableFrom
// stores powerKw as typed, and the car's cap belongs downstream at drawKw.
function persistFrom(m) {
  prefs = persistableFrom(prefs, m);
  savePrefs(prefs);
}

// --- Render everything from current inputs ---
function render() {
  const m = readInputs();
  const cur = prefs.currency;

  const be = breakevenKwhPrice({ gasPrice: m.gasPrice, mpg: m.mpg, miPerKwh: m.miPerKwh });
  const card = $("resultCard");
  const headline = $("headline");
  const sub = $("subline");
  const timeline = $("timeline");
  const touNote = $("touNote");
  const timeNote = $("timeNote");
  const worthTip = $("worthTip");
  const detailLine = $("detailLine");

  // Resolve the ONE active energy-pricing model into a rate function of the
  // session. tod prices by the clock (starting now); dur by elapsed charging
  // time; flat is a single rate. The by-the-hour time fee is layered on top.
  const timeTiers = readTimeFee();
  const hasTimeTiers = timeTiers.length > 0;
  const taxRate = readTaxRate();
  const hasTax = taxRate > 0;
  let rateOf = null, schedule = null, hasRate = false, startClockMin = 0, durTiers = null;
  if (rateMode === "tod") {
    schedule = readSchedule();
    if (schedule.length) { rateOf = (clock) => rateAtTime(schedule, clock); hasRate = true; startClockMin = nowMinutes(); }
  } else if (rateMode === "dur") {
    durTiers = readDurationTiers();
    if (durTiers.length) { rateOf = (_clock, elapsed) => rateAtElapsed(durTiers, elapsed); hasRate = true; }
  }
  if (!rateOf) {
    // Only the flat mode uses the single charger-price field. In time-of-day or
    // by-duration mode with no schedule entered yet there's no price to judge,
    // so leave hasRate false and show the break-even prompt instead of silently
    // reusing the (now disabled) flat field.
    if (rateMode === "flat") hasRate = Number.isFinite(m.yourRate) && m.yourRate >= 0;
    rateOf = () => (hasRate ? m.yourRate : 0);
  }

  // The outlet can be set higher than the car's onboard charger accepts, so cap
  // it here, at the point of use. Clamping the stored value instead would only
  // ever ratchet it down and lose what the user typed, so m.powerKw stays raw
  // all the way to persistFrom below.
  const drawKw = chargeDrawKw(m.powerKw, currentCar());

  const curveArgs = { batteryKwh: m.batteryKwh, startPct: m.startPct, targetPct: m.targetPct, powerKw: drawKw, rateOf, sessionFee: m.sessionFee, timeTiers, taxRate, breakeven: be, startClockMin };

  // Full charge first: its duration is the far end of the "charge for" slider.
  const full = chargeCurve({ ...curveArgs, capMinutes: Infinity });
  const fullChargeMin = full.fullMinutes;

  // Stopping early can change the outcome only when the price gets worse the
  // longer you charge: a by-the-hour time fee, or rising by-duration tiers. In
  // those modes the "Charge for" slider prices a partial charge; otherwise the
  // effective price is flat and stopping early changes nothing.
  const canStopEarly = hasTimeTiers || rateMode === "dur";

  // The longest you can charge while still beating gas, and whether even a short
  // charge loses - both only meaningful when charging longer can worsen the price.
  const worthLimitMin = canStopEarly && full.everWorth ? full.worthLimitMin : null;
  const fullNotWorth = canStopEarly && !full.everWorth;

  // Best-value stop: the partial charge that saves the most vs gas. For rising
  // by-duration tiers, stop where the rate crosses gas; for a per-hour time fee,
  // chargeCurve's most-savings point. Only surface it when it's a confident win
  // and meaningfully better than topping off (>= 3 points more savings).
  const vFull = verdict(full.effectivePerKwh, be);
  let tip = (rateMode === "dur" && worthLimitMin != null && worthLimitMin < fullChargeMin - 0.5)
    ? durSweetSpot(durTiers, be, curveArgs, m, cur)
    : null;
  if (!tip && hasTimeTiers) {
    const s = timeFeeSweetSpot(full, curveArgs, m, cur, be);
    if (s && s.worth && s.improvesBy >= 3) tip = s;
  }
  // Steer to the partial charge ("charge briefly/partway") when topping off to
  // the target isn't itself a confident win but the best-value stop is.
  const showBriefly = !!(tip && vFull !== "worth");

  // Display selection: the slider if the user set it, else the recommended
  // partial charge when we're steering them to stop early, else the full charge.
  let cap = Infinity;
  if (canStopEarly && capTouched && Number.isFinite(chargeCapMin) && chargeCapMin < fullChargeMin - 0.5) cap = chargeCapMin;
  else if (showBriefly && !capTouched) cap = tip.min;
  const session = cap === Infinity ? full : chargeCurve({ ...curveArgs, capMinutes: cap });

  updateChargeSlider(canStopEarly && fullChargeMin > 0, fullChargeMin, session.minutes, session.soc, hasTimeTiers);

  const kwh = session.kwhFromCharger;
  const timeFee = session.timeFee;
  const hasTimeFee = timeFee > 0;
  const hasFees = m.sessionFee > 0 || hasTimeFee || hasTax;

  let effective = NaN;
  if (hasRate) {
    // With a real charge we use the all-in average (energy + fees + tax). Before
    // a battery size is known there's no kWh to amortize per-session/per-hour
    // fees over, so we fall back to the entered rate - but tax is a plain
    // per-kWh multiplier that applies regardless, so keep it in the fallback.
    effective = kwh > 0 ? session.effectivePerKwh : m.yourRate * (1 + taxRate);
  }
  const showEffective = rateMode !== "flat" || hasFees;

  // --- Analytics: categorical funnel + feature usage (each once per session) ---
  if (Number.isFinite(m.mpg) && Number.isFinite(m.miPerKwh)) {
    track("car-selected");
    track(prefs.carId && prefs.carId !== CUSTOM_ID ? "car-from-list" : "car-custom");
  }
  if (hasRate) {
    track("charger-priced");
    track(rateMode === "tod" ? "mode-time-of-day" : rateMode === "dur" ? "mode-by-duration" : "mode-flat");
  }
  if (m.sessionFee > 0) track("fees-session");
  if (hasTimeTiers) track("fees-time");
  if (hasTax) track("fees-tax");

  if (!Number.isFinite(be)) {
    card.dataset.verdict = "close";
    headline.textContent = "\u2026";
    const haveCar = Number.isFinite(m.mpg) && Number.isFinite(m.miPerKwh);
    sub.textContent = haveCar
      ? "Enter your local gas price to see the break-even."
      : "Pick your car to start.";
    timeline.hidden = true;
    touNote.hidden = true;
    timeNote.hidden = true;
    worthTip.hidden = true;
    detailLine.hidden = true;
  } else if (!hasRate) {
    // No charger price yet - the break-even IS the headline answer.
    card.dataset.verdict = "worth";
    headline.textContent = `${money(be, cur)}/kWh`;
    sub.textContent = rateMode === "tod"
      ? "Break-even price. Add your time-of-day rates below for a yes/no."
      : rateMode === "dur"
        ? "Break-even price. Add your duration tiers below for a yes/no."
        : "Break-even price. Enter the charger's energy rate for a yes/no.";
    timeline.hidden = true;
    touNote.hidden = true;
    timeNote.hidden = true;
    worthTip.hidden = true;
    detailLine.hidden = true;
  } else if (Number.isFinite(m.startPct) && Number.isFinite(m.targetPct) && !(m.targetPct > m.startPct)) {
    // Battery is already at (or above) the charge target - there's nothing to
    // charge, so a gas/charge verdict would be misleading. Show a neutral state.
    card.dataset.verdict = "none";
    const atFull = m.targetPct >= 100 || m.startPct >= 100;
    headline.textContent = atFull ? "\uD83D\uDD0B Battery's full" : "\uD83D\uDD0B Nothing to charge";
    sub.textContent = atFull
      ? "Already full, so there's nothing to charge."
      : `Already at your ${Math.round(m.targetPct)}% target. Raise \u201cCharge to\u201d to compare.`;
    timeline.hidden = true;
    touNote.hidden = true;
    timeNote.hidden = true;
    worthTip.hidden = true;
    detailLine.hidden = true;
  } else {
    const v = verdict(effective, be);

    track("verdict-shown");
    track(showBriefly ? "verdict-charge-briefly" : v === "worth" ? "verdict-charge-it" : v === "gas" ? "verdict-use-gas" : "verdict-toss-up");

    card.dataset.verdict = showBriefly ? "close" : (v === "unknown" ? "close" : v);
    // "Briefly" for a genuinely short stop, "partway" once it runs long.
    headline.textContent = showBriefly
      ? (tip.min <= BRIEF_MAX_MIN ? "\u26A1 Charge briefly" : "\u26A1 Charge partway")
      : v === "worth" ? "\u26A1 Charge it" : v === "gas" ? "\u26FD Use gas" : "\u2248 Toss-up";

    // Layman framing: the gas price that would cost the same per mile, plus how
    // much cheaper/pricier charging is per mile. Everyone intuits gas prices.
    const gasPerMile = m.gasPrice / m.mpg;
    const elecPerMile = effective / m.miPerKwh;
    const equivGas = (effective * m.mpg) / m.miPerKwh; // canonical $/gallon
    const equivDisp = U.gasPriceForDisplay(equivGas, prefs.units);
    const gasUnit = prefs.units === "imperial" ? "/gal" : "/L";
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
    // The sub always describes the CURRENT selection (updates live with the
    // slider), so it never disagrees with the price shown for it just below.
    sub.textContent = !(m.gasPrice > 0)
      ? "Gas is free here, so charging can't win."
      : v === "worth"
      ? `Like ${money(equivDisp, cur)}${gasUnit} gas, ${pct}% cheaper`
      : v === "gas"
        ? (mult > 100
            ? "Charging here costs far more than gas."
            : `Like ${money(equivDisp, cur)}${gasUnit} gas, ${pricier}`)
        : pct > 0
          ? `About the same as gas (~${money(equivDisp, cur)}${gasUnit}), leaning ${elecPerMile < gasPerMile ? "cheaper" : "pricier"} ${pct}%`
          : `About the same as gas (~${money(equivDisp, cur)}${gasUnit})`;

    detailLine.hidden = false;
    detailLine.textContent = showEffective
      ? `Effective ${money(effective, cur)}/kWh${hasFees ? " incl. fees" : ""} \u00b7 break-even ${money(be, cur)}/kWh`
      : `You pay ${money(m.yourRate, cur)}/kWh \u00b7 break-even ${money(be, cur)}/kWh`;

    // "How long" at a glance, using your saved battery / power / charge target.
    if (!showBriefly && v !== "gas" && Number.isFinite(session.minutes) && session.minutes > 0) {
      timeline.hidden = false;
      timeline.textContent = `Est. ${formatDuration(session.minutes)} to ${Math.round(session.soc)}% at ${round(drawKw, 2)} kW`;
    } else {
      timeline.hidden = true;
    }

    // Time-of-day suggestion based on the current clock time. Suppressed when a
    // best-value tip is showing, so the card gives one clear action, not two.
    if (rateMode === "tod" && schedule && schedule.length && !tip) {
      const now = nowMinutes();
      const nowRate = rateAtTime(schedule, now);
      const cheap = cheapestPeriod(schedule);
      touNote.hidden = false;
      if (cheap && nowRate > cheap.rate + 1e-9) {
        touNote.textContent = `\u23F0 Cheaper from ${fmtClock(cheap.start)}: ${money(cheap.rate, cur)}/kWh (now ${money(nowRate, cur)})`;
      } else {
        touNote.textContent = `\u2705 You're in the cheapest window now (${money(nowRate, cur)}/kWh)`;
      }
    } else {
      touNote.hidden = true;
    }

    // Best-value tip: when a shorter charge is the smart move (rising duration
    // tiers, or a per-hour time fee whose $/kWh bottoms out below 100%), surface
    // the sweet spot in a distinct green block (miles + saving). Otherwise fall
    // back to the plain worth-limit note or hide it. The "Charge for" slider
    // answers "how far can I go."
    worthTip.hidden = true;
    if (tip) {
      timeNote.hidden = true;
      worthTip.hidden = false;
      $("worthTipLead").textContent = `\uD83D\uDCA1 Best value: charge about ${formatDuration(tip.min)}`;
      $("worthTipSub").textContent = `~${tip.range} ${tip.rangeUnit} \u00b7 like ${tip.equiv}${tip.unit} gas, ${tip.pct}% cheaper`;
    } else if (fullNotWorth) {
      timeNote.hidden = false;
      timeNote.textContent = `\u23F1\uFE0F Even a short charge here costs more than gas.`;
    } else if (worthLimitMin != null && worthLimitMin < fullChargeMin - 0.5) {
      timeNote.hidden = false;
      const why = hasTimeTiers ? "the time fee beats gas" : "the rate climbs past gas";
      timeNote.textContent = `\u23F1\uFE0F Worth it up to about ${formatDuration(worthLimitMin)} of charging (~${Math.round(full.worthLimitSoc)}%). Longer, and ${why}.`;
    } else {
      timeNote.hidden = true;
    }
  }

  renderAdvanced(m, be, cur, session, effective, timeFee, drawKw);
  updatePresetActive();
  persistFrom(m);
}

// The dataset entry for the selected car, or null for a custom car (or none
// picked yet). The only thing that turns prefs into a car, so every charge-power
// cap routes through cars.js and this file never invents its own ceiling.
//
// That is not the same as the cap being pinned here. chargeDrawKw is already
// imported above, so moving the cap up into readInputs is a one-line edit that
// leaves the suite green while ratcheting the capped value into m.powerKw and
// on into storage. The rule is that a capped value never reaches m.powerKw;
// review enforces that, the tests do not.
function currentCar() {
  return prefs.carId && prefs.carId !== CUSTOM_ID ? getCar(prefs.carId) : null;
}

// Highlight the charger-speed preset that matches the current power, if any.
// The car is not consulted: the field and the presets are both outlet rates.
function updatePresetActive() {
  const kw = parseNum($("powerKw").value);
  for (const btn of document.querySelectorAll("#powerPresets .preset")) {
    btn.classList.toggle("is-active", presetMatchesKw(kw, parseNum(btn.dataset.kw)));
  }
}

// The "sweet spot" for rising by-duration tiers: charge through the cheap tiers
// and stop where the next tier's rate first crosses break-even. Every kWh past
// that point costs more than gas, so this maximizes dollars saved. Returns the
// partial charge's gas-equivalent framing (same as the hero), or null when
// there's no clean cheap->pricey crossover.
function durSweetSpot(tiers, breakeven, curveArgs, m, cur) {
  if (!tiers || !(breakeven > 0)) return null;
  if (!(m.mpg > 0) || !(m.miPerKwh > 0)) return null;
  const sorted = tiers
    .filter((t) => Number.isFinite(t.start) && Number.isFinite(t.rate))
    .sort((a, b) => a.start - b.start);
  let stopMin = null;
  for (const t of sorted) { if (t.rate > breakeven) { stopMin = t.start; break; } }
  if (!(stopMin > 0)) return null; // first tier already over gas, or all tiers cheap
  const best = chargeCurve({ ...curveArgs, capMinutes: stopMin });
  const eff = best.effectivePerKwh;
  if (!(eff > 0)) return null;
  const equivGas = (eff * m.mpg) / m.miPerKwh; // canonical $/gallon
  const equivDisp = U.gasPriceForDisplay(equivGas, prefs.units);
  const gpm = m.gasPrice / m.mpg;
  const epm = eff / m.miPerKwh;
  const pct = gpm > 0 ? Math.round(((gpm - epm) / gpm) * 100) : 0;
  const distMiles = m.miPerKwh * best.kwhIntoBattery; // canonical miles added
  const distDisp = (prefs.units === "metric" || prefs.units === "kmL") ? U.kmFromMiles(distMiles) : distMiles;
  return {
    min: stopMin,
    soc: Math.round(best.soc),
    range: Math.round(distDisp),
    rangeUnit: U.labels(prefs.units).distance,
    equiv: money(equivDisp, cur),
    unit: prefs.units === "imperial" ? "/gal" : "/L",
    pct,
  };
}

// The best-value stop for a per-hour time fee. Past the charge taper you pull
// little energy while the clock keeps running, so the all-in $/kWh bottoms out
// before 100% (chargeCurve tracks that point as bestMin). Returns the same
// gas-equivalent framing as the hero, plus whether that stop is a confident win
// (`worth`) and how many points it beats a full charge by (`improvesBy`), so
// the caller can pick "charge it + note" vs "charge briefly". Null when there's
// no meaningfully-earlier stop to recommend.
function timeFeeSweetSpot(full, curveArgs, m, cur, breakeven) {
  if (!(m.mpg > 0) || !(m.miPerKwh > 0)) return null;
  const stopMin = full.bestMin;
  if (!(stopMin > 0) || !(stopMin < full.fullMinutes - 2)) return null; // not meaningfully earlier
  const best = chargeCurve({ ...curveArgs, capMinutes: stopMin });
  const eff = best.effectivePerKwh;
  if (!(eff > 0)) return null;
  const gpm = m.gasPrice / m.mpg;
  const pctOf = (e) => (gpm > 0 ? Math.round(((gpm - e / m.miPerKwh) / gpm) * 100) : 0);
  const pct = pctOf(eff);
  const fullPct = Number.isFinite(full.effectivePerKwh) ? pctOf(full.effectivePerKwh) : 0;
  const equivGas = (eff * m.mpg) / m.miPerKwh; // canonical $/gallon
  const equivDisp = U.gasPriceForDisplay(equivGas, prefs.units);
  const distMiles = m.miPerKwh * best.kwhIntoBattery; // canonical miles added
  const distDisp = (prefs.units === "metric" || prefs.units === "kmL") ? U.kmFromMiles(distMiles) : distMiles;
  return {
    min: stopMin,
    soc: Math.round(best.soc),
    range: Math.round(distDisp),
    rangeUnit: U.labels(prefs.units).distance,
    equiv: money(equivDisp, cur),
    unit: prefs.units === "imperial" ? "/gal" : "/L",
    pct,
    worth: verdict(eff, breakeven) === "worth",
    improvesBy: pct - fullPct,
  };
}

// The "Charge for" slider spans 0 to the full-charge time. It only shows when a
// time fee makes a shorter charge worth considering. Untouched, it sits at the
// full charge so nothing changes; drag it back to price a partial top-up.
function updateChargeSlider(show, fullChargeMin, curMin, curSoc, hasTimeFeeContext = true) {
  const field = $("chargeForField");
  field.hidden = !show;
  if (!show) return;
  const slider = $("chargeForMin");
  const maxMin = Math.max(15, Math.ceil(fullChargeMin));
  slider.max = String(maxMin);
  // Follow the current selection (a dragged cap, the recommended partial, or the
  // full charge) so the slider and the numbers around it always agree.
  slider.value = String(Math.max(0, Math.min(maxMin, Math.round(curMin))));
  $("chargeForOut").textContent = `${formatDuration(Number(slider.value))} (~${Math.round(curSoc)}%)`;
  $("chargeForNote").textContent = Number(slider.value) >= maxMin - 0.5
    ? "Full charge to your target."
    : (hasTimeFeeContext
        ? "Stopping early: less energy, but less time fee."
        : "Stopping early: less energy, and you skip the pricier later rate.");
}

function renderAdvanced(m, be, cur, session, effective, timeFee, drawKw) {
  // Lead with range added (the tangible benefit), keep kWh for pricing context.
  const kwhIn = session.kwhIntoBattery;
  if (Number.isFinite(kwhIn) && kwhIn > 0) {
    const kwhStr = `${kwhIn.toFixed(1)} kWh`;
    if (Number.isFinite(m.miPerKwh) && m.miPerKwh > 0) {
      const dist = m.miPerKwh * kwhIn; // canonical miles
      const distDisp = (prefs.units === "metric" || prefs.units === "kmL") ? U.kmFromMiles(dist) : dist;
      $("advKwh").textContent = `${Math.round(distDisp)} ${U.labels(prefs.units).distance} \u00b7 ${kwhStr}`;
    } else {
      $("advKwh").textContent = kwhStr;
    }
  } else {
    $("advKwh").textContent = "-";
  }
  // The power field holds the OUTLET, so on a car whose onboard charger is
  // slower the estimate runs at a rate that appears nowhere on screen until
  // both prices are in and the verdict card's timeline shows up. This row
  // always renders and sits in the same disclosure as the presets, so it names
  // the rate here. In the label rather than the value because the rate is
  // context and the duration is the answer: muted keeps it from reading as a
  // warning. Only when the cap actually bites, since a car that can take the
  // whole outlet would just repeat the field two rows above.
  const capped = Number.isFinite(drawKw) && Number.isFinite(m.powerKw) && drawKw < m.powerKw - 0.05;
  const hasTime = Number.isFinite(session.minutes) && session.minutes > 0;
  $("advTimeLabel").textContent = capped && hasTime
    ? `Time at ${round(drawKw, 2)} kW (est.)`
    : "Time to charge (est.)";
  $("advTime").textContent = formatDuration(session.minutes);
  const tfRow = $("advTimeFeeRow");
  if (timeFee > 0) {
    tfRow.hidden = false;
    $("advTimeFee").textContent = money(timeFee, cur);
  } else {
    tfRow.hidden = true;
  }
  // Bottom line: the all-in dollar cost of this charge. Only meaningful once a
  // rate is set (effective is finite) and we know the battery size to bill an
  // actual amount of energy against.
  const totalRow = $("advTotalRow");
  if (Number.isFinite(effective) && session.kwhFromCharger > 0 && Number.isFinite(session.totalCost)) {
    totalRow.hidden = false;
    $("advTotal").textContent = money(session.totalCost, cur);
  } else {
    totalRow.hidden = true;
  }
}

// --- Units picker ---
// Each system's compact trigger label plus the clearer open-menu row. "Metric"
// alone is ambiguous now (two metric systems), so the two metric triggers show
// their economy unit (L/100km vs km/L).
const UNIT_SYSTEMS = [
  { system: "imperial", trigger: "US", menu: "US (mpg, gallon)" },
  { system: "uk", trigger: "UK", menu: "UK (mpg, litre)" },
  { system: "metric", trigger: "L/100km", menu: "Metric (L/100km)" },
  { system: "kmL", trigger: "km/L", menu: "Metric (km/L)" },
];

function unitTriggerLabel(system) {
  const u = UNIT_SYSTEMS.find((x) => x.system === system);
  return u ? u.trigger : "US";
}

function applyUnitLabels() {
  const L = U.labels(prefs.units);
  const cur = prefs.currency;
  $("unitBtn").textContent = unitTriggerLabel(prefs.units);
  renderUnitMenu();
  $("gasPriceLabel").textContent = `Gas price (${cur}/${L.gasVolume})`;
  $("yourRateLabel").textContent = `Energy rate (${cur}/kWh)`;
  $("mpgLabel").textContent = `Gas ${L.fuelEconomy}`;
  $("effLabel").textContent = `Electric ${L.evEfficiency}`;
}

function writeDisplayValues() {
  const s = prefs.units;
  // Prices show at up to 6 decimals (trailing zeros trimmed) so switching
  // currency/units or picking a car never rounds away what the user typed
  // (e.g. 3.899, 0.257). Results are still rounded to 2 dp by money().
  $("gasPrice").value = round(U.gasPriceForDisplay(prefs.gasPrice, s), 6);
  $("yourRate").value = round(prefs.yourRate, 6);
  $("mpg").value = round(U.economyForDisplay(prefs.mpg, s), 2);
  $("miPerKwh").value = round(U.efficiencyForDisplay(prefs.miPerKwh, s), 2);
  $("batteryKwh").value = round(prefs.batteryKwh, 2);
  $("sessionFee").value = round(prefs.sessionFee, 2);
  $("powerKw").value = round(prefs.powerKw, 2);
  $("startPct").value = prefs.startPct;
  $("targetPct").value = prefs.targetPct;
  // Keep the invariant even if a stored/edge value has start > target.
  if (parseNum($("startPct").value) > parseNum($("targetPct").value)) {
    $("startPct").value = $("targetPct").value;
  }
  $("startPctOut").textContent = `${$("startPct").value}%`;
  $("targetPctOut").textContent = `${$("targetPct").value}%`;
  $("carNickname").value = prefs.customName || "";
  for (const id of ["curSym1", "curSym2", "curSym3"]) $(id).textContent = prefs.currency;
  // Dynamic pricing rows bake the symbol in at creation; refresh them too on a currency change.
  for (const el of document.querySelectorAll("#touRows .input-money__sym, #durRows .input-money__sym, #timeFeeRows .input-money__sym")) {
    el.textContent = prefs.currency;
  }
  $("currencyBtn").textContent = prefs.currency;
  renderCurrencyMenu();
}

function round(n, d) {
  if (!Number.isFinite(n)) return "";
  const f = Math.pow(10, d);
  return String(Math.round(n * f) / f);
}

// --- Time-of-day helpers ---
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function fmtClock(min) {
  min = ((Math.round(min) % 1440) + 1440) % 1440;
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

// The fee/schedule editor rows (time-of-day, by-duration, station-time, tax)
// are built and read in ./editorRows.js.

// Reflect the selected pricing mode: show the right editor, and disable the flat
// charger-price field when a schedule/tier mode is driving the result instead.
function applyRateMode() {
  $("touEditor").hidden = rateMode !== "tod";
  $("durEditor").hidden = rateMode !== "dur";

  const rateInput = $("yourRate");
  const field = rateInput.closest(".field");
  if (rateMode === "flat") {
    rateInput.disabled = false;
    field.classList.remove("is-disabled");
  } else {
    rateInput.disabled = true;
    field.classList.add("is-disabled");
  }

  if (rateMode === "tod" && $("touRows").children.length === 0) {
    addTouRow(prefs.currency, "00:00", "");
    addTouRow(prefs.currency, "16:00", "");
  }
  if (rateMode === "dur" && $("durRows").children.length === 0) {
    addDurRow(prefs.currency, 0, "");
    addDurRow(prefs.currency, 60, "");
  }
}

// --- Theme toggle (auto -> light -> dark) ---
function updateThemeToggle() {
  const { icon, text } = themeLabel(prefs.themeMode);
  const btn = $("themeToggle");
  btn.textContent = icon;
  btn.setAttribute("aria-label", `Theme: ${text}. Tap to change.`);
  btn.title = `Theme: ${text}`;
}

function cycleTheme() {
  prefs.themeMode = nextThemeMode(prefs.themeMode);
  savePrefs(prefs);
  applyTheme(prefs.themeMode);
  updateThemeToggle();
}

// --- Units picker (a dropdown mirroring the currency picker) ---
// Switch to an explicit unit system. Values in `prefs` are canonical, so we
// capture any in-progress edits first, flip the flag, then relabel/re-render.
// Commit a units choice; the dropdown component owns open/close and focus.
function chooseUnit(system) {
  const m = readInputs();
  persistFrom(m); // capture edits made in the current units first
  prefs.units = system;
  savePrefs(prefs);
  applyUnitLabels(); // relabels #unitBtn and re-renders the menu
  writeDisplayValues();
  render();
}

// Re-render the units menu after the selection changes.
function renderUnitMenu() {
  if (unitDropdown) unitDropdown.render();
}

// Currency is display-only (both prices are entered in the user's own currency),
// so switching it just relabels and re-renders without touching any values.
function setCurrency(sym) {
  const m = readInputs();
  persistFrom(m); // keep any in-progress edits before re-rendering
  prefs.currency = sym;
  savePrefs(prefs);
  applyUnitLabels();
  writeDisplayValues();
  render();
}

// Currency picker options: `sym` is the symbol shown app-wide (and stored in
// prefs.currency); `name` labels the open menu row. The closed trigger shows
// only the symbol; the open menu shows aligned symbol + name rows, because the
// native OS select menu can't be styled to line those up.
const CURRENCIES = [
  { sym: "$", name: "US Dollar" },
  { sym: "\u20AC", name: "Euro" },
  { sym: "\u00A3", name: "Pound" },
  { sym: "\u00A5", name: "Yen" },
  { sym: "\u20B9", name: "Rupee" },
  { sym: "\u20A9", name: "Won" },
  { sym: "Fr", name: "Franc" },
  { sym: "kr", name: "Krona" },
  { sym: "R$", name: "Real" },
  { sym: "A$", name: "Australian $" },
  { sym: "C$", name: "Canadian $" },
  { sym: "\u20BD", name: "Ruble" },
];

// Re-render the currency menu after the selection changes.
function renderCurrencyMenu() {
  if (currencyDropdown) currencyDropdown.render();
}

// --- Car selection ---
const CUSTOM_ID = "__custom__";

function setCar(car, { keepCustom = false } = {}) {
  // applyCarSelection owns which fields a car fills in (and which it must leave
  // alone, powerKw above all); keepCustom means take the identity only.
  prefs = keepCustom ? { ...prefs, carId: car.id } : applyCarSelection(prefs, car);
  savePrefs(prefs);
  $("carName").textContent = `${car.make} ${car.model}`;
  $("carSearch").value = carLabel(car);
  $("nicknameField").hidden = true;
  $("tweak").open = false;
  writeDisplayValues();
  render();
}

// Switch to a user-defined car: keep the current numbers, drive the label from
// the nickname, and reveal the numbers so the user can enter their own.
function setCustomCar() {
  prefs.carId = CUSTOM_ID;
  // Restore this custom car's saved numbers if we have them; otherwise keep
  // whatever's showing so the user can adjust from there.
  const ov = prefs.carOverrides ? prefs.carOverrides[CUSTOM_ID] : null;
  if (ov) {
    if (Number.isFinite(ov.mpg)) prefs.mpg = ov.mpg;
    if (Number.isFinite(ov.miPerKwh)) prefs.miPerKwh = ov.miPerKwh;
    if (Number.isFinite(ov.batteryKwh)) prefs.batteryKwh = ov.batteryKwh;
  }
  savePrefs(prefs);
  $("carName").textContent = prefs.customName || "My car";
  $("carSearch").value = "My own car";
  $("nicknameField").hidden = false;
  $("tweak").open = true;
  $("carTile").open = true;
  writeDisplayValues();
  render();
  $("mpg").focus();
}

// --- Searchable car picker (typeahead over the bundled dataset) ---
// Normalize so punctuation/casing don't block matches, and "+" reads as "plus"
// (so "450h+" finds "450h Plus", "TFSI e" finds "TFSIe", etc.).
function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function filterCars(query) {
  const q = normalizeText(query);
  const all = getCars(); // already sorted by make, model, newest year
  if (!q) return all;
  const tokens = q.split(/\s+/);
  return all.filter((c) => {
    const label = normalizeText(`${c.year} ${c.make} ${c.model}`);
    return tokens.every((t) => label.includes(t));
  });
}

// This is a combobox, not a menu: focus stays in the text field the whole time
// so typing keeps working, and the "which row am I on" state that focus would
// normally carry has to be tracked by hand and published as
// aria-activedescendant. That is the one real difference from dropdown.js,
// where the rows take DOM focus outright.
const carOptionId = (i) => `carOption-${i}`;
// Index into the rendered .combo__item rows, or -1 for "none, the caret is
// still just in the text field". Mouse hover deliberately does not move it.
let carActiveIndex = -1;
// The text Escape puts back. It is sampled at the two moments the field is
// settled, focus and close, and never while the list is open. Every close is a
// real one: the deferred blur close is cancelled on refocus, so a timer from a
// blur the user already undid cannot land mid-query and bank a half-typed
// search. It cannot be sampled on open: typing is itself an open, and by the
// time the input event runs the keystroke is already in the value, so opening
// that way would bank the character the user is about to ask us to throw away.
let carRestoreValue = "";
// The pending deferred close from a blur, held so a refocus can cancel it.
let carBlurTimer = null;

function carOptionEls() {
  return [...$("carResults").querySelectorAll(".combo__item")];
}

// Single place that paints the active row: the attribute a screen reader
// follows and the styling everyone else sees, set together so they cannot drift.
function setCarActive(index) {
  const items = carOptionEls();
  carActiveIndex = index >= 0 && index < items.length ? index : -1;
  items.forEach((li, i) => {
    const on = i === carActiveIndex;
    li.classList.toggle("combo__item--active", on);
    li.setAttribute("aria-selected", on ? "true" : "false");
  });
  const active = carActiveIndex >= 0 ? items[carActiveIndex] : null;
  if (!active) {
    $("carSearch").removeAttribute("aria-activedescendant");
    return;
  }
  $("carSearch").setAttribute("aria-activedescendant", active.id);
  // "nearest" scrolls the 46vh results panel and leaves the page alone.
  active.scrollIntoView({ block: "nearest" });
}

function renderCarResults(query) {
  const ul = $("carResults");
  ul.innerHTML = "";

  const custom = document.createElement("li");
  custom.className = "combo__item combo__item--custom";
  custom.id = carOptionId(0);
  custom.dataset.id = CUSTOM_ID;
  custom.setAttribute("role", "option");
  custom.setAttribute("aria-selected", "false");
  custom.textContent = "\u270F\uFE0F My own car (enter numbers)";
  ul.appendChild(custom);

  const results = filterCars(query);
  results.forEach((car, i) => {
    const li = document.createElement("li");
    li.className = "combo__item";
    li.id = carOptionId(i + 1); // the custom row is always option 0
    li.dataset.id = car.id;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", "false");
    li.textContent = carLabel(car);
    ul.appendChild(li);
  });
  if (!results.length && query.trim()) {
    const none = document.createElement("li");
    none.className = "combo__none";
    // A listbox may only contain options, so a bare <li> here was a malformed
    // child the whole time. It is a message and not a choice, hence disabled,
    // and it carries no .combo__item class so the arrow keys skip past it.
    none.setAttribute("role", "option");
    none.setAttribute("aria-disabled", "true");
    none.setAttribute("aria-selected", "false");
    // This used to read "No matches, try a make or model.", which sent people
    // back to search differently for a car that is not in the dataset. The way
    // out is the custom row, which is sitting directly above this message as
    // the first option in the same list, so point at it instead. Same wording
    // as the (i) note above the field, so the two agree.
    none.textContent = "No match. Pick \u201cMy own car\u201d at the top to enter your own.";
    ul.appendChild(none);
  }

  ul.hidden = false;
  $("carSearch").setAttribute("aria-expanded", "true");
  // The rows underneath just changed, so any previously active one is gone.
  setCarActive(-1);
}

function hideCarResults() {
  $("carResults").hidden = true;
  $("carSearch").setAttribute("aria-expanded", "false");
  // Every row is still in the DOM here; renderCarResults is what replaces them.
  // This clears because the listbox is hidden as of the line above, and an
  // active option inside a hidden listbox points a screen reader at a row the
  // user can no longer see or move to.
  $("carSearch").removeAttribute("aria-activedescendant");
  carActiveIndex = -1;
  // Whatever the field reads now is the baseline the next search starts from,
  // whether a selection just wrote a label into it, Escape just put the old
  // text back, Enter dismissed the list, or a blur left the typing where it
  // stood. Escape reaching here re-banks the value it restored a line earlier,
  // which is a no-op by construction.
  carRestoreValue = $("carSearch").value;
}

// --- Events ---
let copyToastTimer = null;

function showCopyToast(message) {
  document.querySelector(".toast--copy")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast toast--copy";
  toast.setAttribute("role", "status");
  // The update toast is pinned to the same spot, so sit above it rather than on it.
  if (document.querySelector(".toast:not(.toast--copy)")) toast.classList.add("toast--stacked");
  const text = document.createElement("span");
  text.className = "toast__text";
  toast.append(text);
  document.body.appendChild(toast);
  // Fill after insertion: a live region that arrives already populated is not
  // reliably announced, and this toast is the only confirmation of the copy.
  requestAnimationFrame(() => { text.textContent = message; });
  clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => toast.remove(), 2500);
}

function attachEvents() {
  const liveIds = ["gasPrice", "yourRate", "mpg", "miPerKwh", "batteryKwh", "sessionFee", "powerKw"];
  for (const id of liveIds) $(id).addEventListener("input", render);

  // Remember the user's edits per car: tweaking the car numbers saves an
  // override keyed to the current car, so switching away and back restores them.
  // Watch exactly the fields applyCarEdit copies (CAR_EDIT_FIELDS is the one
  // list), so widening this loop can't smuggle a non-car field into a car.
  for (const id of CAR_EDIT_FIELDS) {
    $(id).addEventListener("input", () => {
      if (!prefs.carId) return;
      prefs = applyCarEdit(prefs, prefs.carId, readInputs());
      savePrefs(prefs);
    });
  }

  // These fields are text inputs (so decimal-comma locales can type a comma)
  // with an inputmode for the numeric keypad; identify them by inputmode, not
  // type. Focusing selects the contents ONLY while a field still holds its
  // untouched default, so one keystroke replaces it; once you've typed your own
  // value, focusing leaves it alone so you can edit/append.
  const isNumField = (el) => el && el.tagName === "INPUT" &&
    (el.inputMode === "decimal" || el.inputMode === "numeric");
  const touchedFields = new WeakSet();
  document.addEventListener("input", (e) => {
    if (isNumField(e.target)) touchedFields.add(e.target);
  });
  // Block typing a character that isn't a digit or decimal separator, so unwanted
  // input (letters, a currency symbol, %, spaces) never appears. Using beforeinput
  // lets the browser keep the caret naturally; deletions and navigation pass
  // through, and pasted junk is normalized/cleared on blur.
  document.addEventListener("beforeinput", (e) => {
    const el = e.target;
    if (!isNumField(el)) return;
    if (e.inputType === "insertText" && e.data && /[^\d.,]/.test(e.data)) {
      e.preventDefault();
    }
  });
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (isNumField(el) && !touchedFields.has(el)) {
      requestAnimationFrame(() => { try { el.select(); } catch (_) { /* ignore */ } });
    }
  });

  // Numbers never need more than 2 decimals: round on commit (blur/Enter). This
  // also normalizes a decimal comma to a dot so the displayed value is canonical.
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!isNumField(el) || el.value.trim() === "") return;
    const n = parseNum(el.value);
    if (Number.isFinite(n)) {
      const rounded = Math.round(n * 100) / 100;
      if (String(rounded) !== el.value) {
        el.value = String(rounded);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      // No usable number (e.g. "abc") - clear it so the field never keeps junk
      // once you leave it. (Mobile keypads block letters; this covers desktop.)
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  // "Battery now" can't exceed "Charge to" (and vice versa): they can meet but
  // never cross.
  $("startPct").addEventListener("input", (e) => {
    const target = parseNum($("targetPct").value);
    let v = parseNum(e.target.value);
    if (Number.isFinite(target) && v > target) { v = target; e.target.value = String(v); }
    $("startPctOut").textContent = `${v}%`;
    render();
  });
  $("targetPct").addEventListener("input", (e) => {
    const start = parseNum($("startPct").value);
    let v = parseNum(e.target.value);
    if (Number.isFinite(start) && v < start) { v = start; e.target.value = String(v); }
    $("targetPctOut").textContent = `${v}%`;
    render();
  });
  $("chargeForMin").addEventListener("input", (e) => {
    capTouched = true;
    chargeCapMin = parseNum(e.target.value);
    track("feature-charge-for-slider");
    render();
  });

  // Currency + units pickers: custom dropdowns (native selects can't be styled
  // or lay out the symbol + name rows). Both use the shared dropdown component,
  // which handles open/close, outside-click, and keyboard nav.
  currencyDropdown = createDropdown({
    trigger: "currencyBtn",
    menu: "currencyMenu",
    itemClass: "currency-item",
    options: () => CURRENCIES,
    getValue: () => prefs.currency,
    optionValue: (c) => c.sym,
    renderItem: (li, c) => {
      const sym = document.createElement("span");
      sym.className = "currency-item__sym";
      sym.textContent = c.sym;
      const name = document.createElement("span");
      name.className = "currency-item__name";
      name.textContent = c.name;
      li.append(sym, name);
    },
    onChange: (sym) => setCurrency(sym),
  });
  unitDropdown = createDropdown({
    trigger: "unitBtn",
    menu: "unitMenu",
    itemClass: "unit-item",
    options: () => UNIT_SYSTEMS,
    getValue: () => prefs.units,
    optionValue: (u) => u.system,
    renderItem: (li, u) => { li.textContent = u.menu; },
    onChange: (system) => chooseUnit(system),
  });
  $("themeToggle").addEventListener("click", cycleTheme);
  // Re-resolve auto theme when the user returns (day may have turned to night).
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && prefs.themeMode === "auto") applyTheme("auto");
  });
  // Pricing mode (flat / time-of-day / duration) - exclusive, not persisted.
  for (const radio of document.querySelectorAll('input[name="rateMode"]')) {
    radio.addEventListener("change", (e) => {
      rateMode = e.target.value;
      applyRateMode();
      render();
    });
  }
  $("touAdd").addEventListener("click", () => {
    addTouRow(prefs.currency);
    render();
  });
  $("touRows").addEventListener("input", render);
  $("touRows").addEventListener("click", (e) => {
    if (e.target.classList.contains("tou-del")) {
      e.target.closest(".tou-row").remove();
      render();
    }
  });
  $("durAdd").addEventListener("click", () => {
    addDurRow(prefs.currency);
    render();
  });
  $("durRows").addEventListener("input", render);
  $("durRows").addEventListener("click", (e) => {
    if (e.target.classList.contains("tou-del")) {
      e.target.closest(".tou-row").remove();
      render();
    }
  });

  $("powerPresets").addEventListener("click", (e) => {
    const btn = e.target.closest(".preset");
    if (!btn) return;
    // Presets are the outlet's rate (Level 1 / Level 2), so each writes exactly
    // the number on its label. Nothing on this path is capped: a car-derived
    // value here would flow through readInputs into m.powerKw and on into
    // storage, where it would outlive the car that produced it and shorten the
    // next car's estimate. The ceiling belongs at chargeDrawKw in render().
    $("powerKw").value = round(parseNum(btn.dataset.kw), 2);
    render();
  });

  $("timeFeeAdd").addEventListener("click", () => {
    addTimeFeeRow(prefs.currency);
    render();
  });
  $("timeFeeRows").addEventListener("input", render);
  $("timeFeeRows").addEventListener("change", render); // hr/min unit select
  $("timeFeeRows").addEventListener("click", (e) => {
    if (e.target.classList.contains("tou-del")) {
      e.target.closest(".tou-row").remove();
      render();
    }
  });

  $("taxAdd").addEventListener("click", () => {
    addTaxRow();
    render();
  });
  $("taxRows").addEventListener("input", render);
  $("taxRows").addEventListener("click", (e) => {
    if (e.target.classList.contains("tou-del")) {
      e.target.closest(".tou-row").remove();
      render();
    }
  });

  // Info notes: show on hover/focus (desktop), tap to pin open (touch). A pinned
  // note dismisses on Escape or a pointer/focus event outside it - not only by
  // tapping the (i) again.
  const wireInfo = (btnId, noteId) => {
    const infoBtn = $(btnId), infoNote = $(noteId);
    if (!infoBtn || !infoNote) return;
    infoBtn.setAttribute("aria-controls", noteId);
    // The note is `hidden`, so it is absent from the accessibility tree and a
    // screen reader can never reach it. aria-describedby resolves THROUGH the
    // hidden attribute (checked in Chrome's accessibility tree: the computed
    // description is byte-identical hidden or shown), so associating it
    // announces the text without revealing the note. It goes on the input the
    // note explains, so it arrives with the thing it is about. The two notes
    // that head a group of rows have no single input, so their (i) carries it.
    // Never both: the (i) sits immediately before its input in the tab order,
    // so describing both would read the same paragraph out twice in a row.
    const labelled = infoBtn.closest(".field-label-row")?.querySelector("label[for]");
    const described = (labelled && $(labelled.htmlFor)) || infoBtn;
    described.setAttribute("aria-describedby", noteId);
    let pinned = false;
    const show = (v) => {
      infoNote.hidden = !v;
      infoBtn.setAttribute("aria-expanded", String(v));
    };
    const outside = (e) => !infoBtn.contains(e.target) && !infoNote.contains(e.target);
    const onDocDown = (e) => { if (outside(e)) setPinned(false); };
    // Focus can move from the (i) INTO the note: it ends in a source link, and a
    // visible link is focusable. Tab, and the browser picks that link as the next
    // stop, which blurs the (i) - and hiding the note on that blur takes the link
    // out of the document before the focus lands on it, so the focus lands
    // nowhere and the browser drops it on <body>. The link's own focus event
    // never fires at all. That was the dead Tab stop: one keypress that moves
    // nothing and leaves a keyboard user with no position in the page.
    //
    // The note stays open while focus is anywhere inside the pair, so the link
    // is reachable rather than unreachable. Making it unfocusable would also
    // have removed the dead stop, by removing the only way to get to the one
    // link in the note, which is not a fix.
    const holdsFocus = () => infoBtn.contains(document.activeElement) || infoNote.contains(document.activeElement);
    // On blur/focusout, relatedTarget is where focus is GOING (null when it
    // leaves the page). document.activeElement is still the old element here,
    // so it cannot answer this question.
    const leaving = (e) => !e.relatedTarget || !(infoBtn.contains(e.relatedTarget) || infoNote.contains(e.relatedTarget));
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      // Escape with focus inside the note has the same problem: hide first and
      // the focus falls to <body>. Hand it back to the (i), which is where the
      // note was opened from. Done while still pinned so the (i)'s own focus
      // handler stays quiet and doesn't reopen what Escape just closed.
      if (infoNote.contains(document.activeElement)) {
        infoBtn.focus();
        setPinned(false);
        return;
      }
      setPinned(false);
      infoBtn.blur();
    };
    const setPinned = (v) => {
      if (v === pinned) { show(v); return; }
      pinned = v;
      show(v);
      // Capture-phase so we still catch clicks on elements that stop propagation.
      if (v) {
        document.addEventListener("pointerdown", onDocDown, true);
        document.addEventListener("keydown", onKey, true);
      } else {
        document.removeEventListener("pointerdown", onDocDown, true);
        document.removeEventListener("keydown", onKey, true);
      }
    };
    infoBtn.addEventListener("mouseenter", () => { if (!pinned) show(true); });
    // Moving the mouse away must not close a note the keyboard is standing in.
    infoBtn.addEventListener("mouseleave", () => { if (!pinned && !holdsFocus()) show(false); });
    infoBtn.addEventListener("focus", () => { if (!pinned) show(true); });
    infoBtn.addEventListener("blur", (e) => { if (!pinned && leaving(e)) show(false); });
    // focusout bubbles, so this covers the link and anything added to the note later.
    infoNote.addEventListener("focusout", (e) => { if (!pinned && leaving(e)) show(false); });
    infoBtn.addEventListener("click", (e) => { e.stopPropagation(); setPinned(!pinned); });
  };
  wireInfo("carInfoBtn", "carInfoNote");
  wireInfo("batteryInfoBtn", "batteryInfoNote");
  wireInfo("powerInfoBtn", "powerInfoNote");
  wireInfo("timeFeeInfoBtn", "timeFeeInfoNote");
  wireInfo("taxInfoBtn", "taxInfoNote");

  $("carSearch").addEventListener("focus", (e) => {
    track("car-search-focused"); // diagnostic: did they engage the first step at all?
    // A close still pending from a blur belongs to a blur this focus just undid.
    // Left to land it closes the list the user is typing into and banks that
    // half-typed query as the Escape value, so drop it here rather than teach
    // hideCarResults to second-guess whoever called it.
    clearTimeout(carBlurTimer);
    // boot() fills this field from saved prefs without the list ever closing,
    // so first focus is the only chance to bank that label before the list opens.
    carRestoreValue = e.target.value;
    e.target.select();
    renderCarResults(e.target.value === "My own car" ? "" : e.target.value);
  });
  $("carSearch").addEventListener("input", (e) => renderCarResults(e.target.value));
  // Deferred so a mousedown on a row lands before the list goes away.
  $("carSearch").addEventListener("blur", () => {
    carBlurTimer = setTimeout(hideCarResults, 120);
  });

  // One commit path for both mouse and keyboard, so the two cannot diverge.
  // keepFocus is the difference between them: a click is a finished gesture, but
  // a keyboard user who is dropped onto <body> has lost their place in the tab
  // order, so Enter leaves them in the field they were already in.
  const chooseCarOption = (li, { keepFocus = false } = {}) => {
    const id = li?.dataset.id;
    if (!id) return;
    if (id === CUSTOM_ID) setCustomCar(); // this one moves focus to mpg on purpose
    else { const car = getCar(id); if (car) setCar(car); }
    hideCarResults();
    if (!keepFocus) $("carSearch").blur();
  };

  $("carResults").addEventListener("mousedown", (e) => {
    const li = e.target.closest(".combo__item");
    if (!li) return;
    e.preventDefault(); // select before the input's blur hides the list
    chooseCarOption(li);
  });

  // Arrow/Enter/Escape on the input itself. Nothing here touches aria-expanded:
  // it opens by calling renderCarResults and closes by calling hideCarResults,
  // which are still the only two writers of it.
  $("carSearch").addEventListener("keydown", (e) => {
    const closed = $("carResults").hidden;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); // otherwise the caret jumps to one end of the text
      if (closed) renderCarResults(e.target.value === "My own car" ? "" : e.target.value);
      setCarActive(nextOptionIndex(carActiveIndex, carOptionEls().length, e.key));
    } else if (e.key === "Enter") {
      const action = enterAction(!closed, carActiveIndex);
      if (action === "ignore") return;
      e.preventDefault();
      // Nothing active means a soft keyboard, which sends no arrow keys at all.
      // Dismissing the list is the least this key can do and still mean something.
      if (action === "close") hideCarResults();
      else chooseCarOption(carOptionEls()[carActiveIndex], { keepFocus: true });
    } else if (e.key === "Escape") {
      if (closed) return;
      e.preventDefault();
      // Escape cancels the search, so put back the text the box opened with.
      e.target.value = carRestoreValue;
      hideCarResults();
    }
    // Home and End are left alone on purpose: this is an editable combobox, so
    // they belong to the caret in the text field, not to the list.
  });

  $("carNickname").addEventListener("input", (e) => {
    prefs.customName = e.target.value.trim();
    savePrefs(prefs);
    if (prefs.carId === CUSTOM_ID) {
      $("carName").textContent = prefs.customName || "My car";
    }
  });

  // track() dedupes per session, so this counts visits that reached out, not clicks.
  $("feedbackLink").addEventListener("click", () => {
    track("feedback-clicked");
    // Read the address off the href so it can never drift from what the link opens.
    const email = $("feedbackLink").href.replace(/^mailto:/, "").split("?")[0];
    const copied = navigator.clipboard?.writeText(email);
    if (!copied) return;
    copied.then(() => showCopyToast("Email address copied"), () => {});
  });

  $("resetBtn").addEventListener("click", () => {
    prefs = resetPrefs();
    // Reset volatile UI too: pricing mode, schedule/tier rows, info note.
    rateMode = "flat";
    chargeCapMin = null;
    capTouched = false;
    const flatRadio = document.querySelector('input[name="rateMode"][value="flat"]');
    if (flatRadio) flatRadio.checked = true;
    $("touRows").innerHTML = "";
    $("durRows").innerHTML = "";
    $("timeFeeRows").innerHTML = "";
    $("taxRows").innerHTML = "";
    $("carInfoNote").hidden = true;
    $("carInfoBtn").setAttribute("aria-expanded", "false");
    boot();
  });
}

// --- Boot ---
function boot() {
  applyTheme(prefs.themeMode);
  updateThemeToggle();
  applyUnitLabels();
  const maxLen = maxLabelLength();
  if (maxLen) $("carSearch").maxLength = maxLen;
  if (prefs.carId === CUSTOM_ID) {
    $("carName").textContent = prefs.customName || "My car";
    $("carSearch").value = "My own car";
    $("nicknameField").hidden = false;
    $("tweak").open = true;
  } else {
    const car = getCar(prefs.carId);
    if (car) {
      $("carName").textContent = `${car.make} ${car.model}`;
      $("carSearch").value = carLabel(car);
      $("tweak").open = false;
    } else {
      // Clean slate - nudge the user to pick a car.
      $("carName").textContent = "Select your car";
      $("carSearch").value = "";
      $("carTile").open = true;
      $("tweak").open = false;
    }
    $("nicknameField").hidden = true;
  }
  writeDisplayValues();
  applyRateMode();
  render();
}

// --- PWA update watch -------------------------------------------------------
// Detect when a newer deploy is live and offer a non-disruptive "refresh"
// toast. We never reload on our own - the user taps Refresh when they're ready,
// so an update can never interrupt them mid-calculation.
//
// How we know a new version shipped:
//   1. version.json - stamped with the commit SHA by the deploy workflow. This
//      catches EVERY change (including internal JS that never appears in
//      index.html) with a single tiny request per check.
//   2. Fallback (no CI yet): fingerprint the core assets by hashing their
//      contents, so an internal-only change is still caught. Costs a few small
//      requests, so it's only used when version.json is absent.
//
// Every request appends ?__vcheck=1 so the service worker passes it straight to
// the network (see service-worker.js) - never cached, never stale.
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000; // re-check every 15 min while open
const UPDATE_FINGERPRINT_ASSETS = [
  "./index.html", "./css/styles.css",
  "./js/main.js", "./js/calc.js", "./js/units.js", "./js/storage.js",
  "./js/cars.js", "./js/ui.js", "./js/theme.js", "./js/analytics.js",
  "./data/phevs.json",
];

function hashText(text) {
  // djb2 - a compact, dependency-free fingerprint. Not cryptographic; we only
  // need "did the bytes change", not security.
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function fetchVersionSignature() {
  // Prefer the CI-stamped commit SHA: one request, catches every change.
  try {
    const res = await fetch("./version.json?__vcheck=1", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.commit === "string" && data.commit && data.commit !== "dev") {
        return `v:${data.commit}`;
      }
    }
  } catch { /* fall through to the asset fingerprint */ }

  // Fallback: hash the core assets so internal-only changes still register.
  // If ANY asset can't be fetched (e.g. offline), we can't form a reliable
  // fingerprint, so return null and let the caller skip this round. (Never
  // hash partial/empty responses - that would fabricate a "new version".)
  try {
    const texts = await Promise.all(UPDATE_FINGERPRINT_ASSETS.map((u) =>
      fetch(`${u}?__vcheck=1`, { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error("asset unavailable");
        return r.text();
      })
    ));
    return `h:${hashText(texts.join("\u0000"))}`;
  } catch {
    return null;
  }
}

function setupUpdateWatch() {
  let baseline = null;      // signature of the build this tab is running
  let toastVisible = false; // a refresh toast is currently on screen
  let dismissed = false;    // user dismissed - stay quiet for the rest of the session
  let lastCheck = 0;

  function showUpdateToast() {
    if (toastVisible) return;
    toastVisible = true;

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");

    const text = document.createElement("span");
    text.className = "toast__text";
    text.textContent = "A new version is available.";

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "toast__action";
    refresh.textContent = "Refresh";
    refresh.addEventListener("click", () => window.location.reload());

    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast__dismiss";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "\u2715";
    close.addEventListener("click", () => {
      dismissed = true;
      toastVisible = false;
      toast.remove();
    });

    toast.append(text, refresh, close);
    document.body.appendChild(toast);
  }

  async function check() {
    // Never stack toasts or nag: at most one toast until the user acts, and
    // once dismissed we stay quiet. This is what keeps 20 pushes in a day from
    // becoming 20 toasts - the tab shows one, then it's silent until refreshed.
    if (dismissed || toastVisible) return;
    if (navigator.onLine === false) return; // offline: nothing to check, try again later
    const now = Date.now();
    if (now - lastCheck < 60 * 1000) return; // debounce focus/interval bursts
    lastCheck = now;

    const sig = await fetchVersionSignature();
    if (!sig) return; // no reliable answer (e.g. dropped offline mid-check) - skip, keep baseline
    if (baseline === null) { baseline = sig; return; } // first read = the build we booted with
    if (sig !== baseline) showUpdateToast();           // anything newer -> offer refresh
  }

  check(); // establish the baseline for this session
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check(); // catch updates on resume
  });
}

async function init() {
  await loadCars();
  attachEvents();
  boot();

  // PWA signals. "standalone" = launched from an installed copy (fires on every
  // such session); "installed" = the one-time install event (not fired by iOS
  // Safari, which has no appinstalled event - those show up as standalone).
  if (window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone) {
    trackWhenReady("pwa-standalone");
  }
  window.addEventListener("appinstalled", () => trackWhenReady("pwa-installed"));

  if ("serviceWorker" in navigator) {
    const isLocal = ["localhost", "127.0.0.1", "[::1]", ""].includes(location.hostname);
    if (isLocal) {
      // Local dev: don't let a cached service worker hide file changes. Tear
      // down any existing registration + caches so every reload is fresh.
      navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
      if (self.caches) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
    } else {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {});
      setupUpdateWatch();
    }
  }
}

init();
