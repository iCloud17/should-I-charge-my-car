// main.js - wire inputs → calc → render. Persist to localStorage.

import { breakevenKwhPrice, chargeCurve, verdict, rateAtTime, rateAtElapsed, cheapestPeriod } from "./calc.js";
import * as U from "./units.js";
import { loadPrefs, savePrefs, clearPrefs, DEFAULT_PREFS } from "./storage.js";
import { loadCars, getCar, getCars, carLabel, maxLabelLength } from "./cars.js";
import { $, parseNum, money, formatDuration, escapeHtml } from "./ui.js";
import { applyTheme, nextThemeMode, themeLabel } from "./theme.js";

let prefs = loadPrefs();
let rateMode = "flat"; // "flat" | "tod" | "dur" (volatile - never persisted)
let chargeCapMin = null; // "charge for" slider value in minutes (volatile)
let capTouched = false;  // has the user dragged the "charge for" slider?

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

function persistFrom(m) {
  prefs = {
    ...prefs,
    gasPrice: m.gasPrice,
    yourRate: m.yourRate,
    mpg: m.mpg,
    miPerKwh: m.miPerKwh,
    batteryKwh: m.batteryKwh,
    sessionFee: m.sessionFee,
    powerKw: m.powerKw,
    startPct: m.startPct,
    targetPct: m.targetPct,
  };
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
  let rateOf = null, schedule = null, hasRate = false, startClockMin = 0, durTiers = null;
  if (rateMode === "tod") {
    schedule = readSchedule();
    if (schedule.length) { rateOf = (clock) => rateAtTime(schedule, clock); hasRate = true; startClockMin = nowMinutes(); }
  } else if (rateMode === "dur") {
    durTiers = readDurationTiers();
    if (durTiers.length) { rateOf = (_clock, elapsed) => rateAtElapsed(durTiers, elapsed); hasRate = true; }
  }
  if (!rateOf) {
    // Flat rate (also the fallback when a schedule/tier list isn't filled in yet).
    hasRate = Number.isFinite(m.yourRate) && m.yourRate >= 0;
    rateOf = () => (hasRate ? m.yourRate : 0);
  }

  const curveArgs = { batteryKwh: m.batteryKwh, startPct: m.startPct, targetPct: m.targetPct, powerKw: m.powerKw, rateOf, sessionFee: m.sessionFee, timeTiers, breakeven: be, startClockMin };

  // Full charge first: its duration is the far end of the "charge for" slider.
  const full = chargeCurve({ ...curveArgs, capMinutes: Infinity });
  const fullChargeMin = full.fullMinutes;

  // Stopping early can change the outcome only when the price gets worse the
  // longer you charge: a by-the-hour time fee, or rising by-duration tiers. In
  // those modes the "Charge for" slider prices a partial charge; otherwise the
  // effective price is flat and stopping early changes nothing.
  const canStopEarly = hasTimeTiers || rateMode === "dur";
  let cap = Infinity;
  if (canStopEarly && capTouched && Number.isFinite(chargeCapMin) && chargeCapMin < fullChargeMin - 0.5) cap = chargeCapMin;
  const session = cap === Infinity ? full : chargeCurve({ ...curveArgs, capMinutes: cap });

  updateChargeSlider(canStopEarly && fullChargeMin > 0, fullChargeMin, session.minutes, session.soc, hasTimeTiers);

  const kwh = session.kwhFromCharger;
  const timeFee = session.timeFee;
  const hasTimeFee = timeFee > 0;
  const hasFees = m.sessionFee > 0 || hasTimeFee;

  let effective = NaN;
  if (hasRate) {
    effective = kwh > 0 ? session.effectivePerKwh : m.yourRate;
  }
  const showEffective = rateMode !== "flat" || hasFees;

  // The longest you can charge here while still beating gas (accurate crossover).
  // Applies whenever charging longer worsens the effective price: a time fee or
  // rising by-duration tiers. chargeCurve already folds tier rates into it.
  const worthLimitMin = canStopEarly && full.everWorth ? full.worthLimitMin : null;
  const fullNotWorth = canStopEarly && !full.everWorth;

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
    sub.textContent = "Break-even price. Enter the charger's energy rate for a yes/no.";
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

    // Best-value recommendation: when a shorter charge is genuinely worth it
    // (rising by-duration tiers) but the currently-selected charge isn't, the
    // honest tone is amber "charge briefly," not a red "use gas." Gating on the
    // live verdict (not on whether the slider was touched) means nudging the
    // slider never snaps to a scary red - it stays amber until you actually
    // land on a worth-it duration, then turns green.
    const sweet = (rateMode === "dur" && worthLimitMin != null && worthLimitMin < fullChargeMin - 0.5)
      ? durSweetSpot(durTiers, be, curveArgs, m, cur)
      : null;
    const showBriefly = sweet && v !== "worth";

    card.dataset.verdict = showBriefly ? "close" : (v === "unknown" ? "close" : v);
    headline.textContent = showBriefly
      ? "\u26A1 Charge briefly"
      : v === "worth" ? "\u26A1 Charge it" : v === "gas" ? "\u26FD Use gas" : "\u2248 Toss-up";

    // Layman framing: the gas price that would cost the same per mile, plus how
    // much cheaper/pricier charging is per mile. Everyone intuits gas prices.
    const gasPerMile = m.gasPrice / m.mpg;
    const elecPerMile = effective / m.miPerKwh;
    const equivGas = (effective * m.mpg) / m.miPerKwh; // canonical $/gallon
    const equivDisp = U.gasPriceForDisplay(equivGas, prefs.units);
    const gasUnit = prefs.units === "metric" ? "/L" : "/gal";
    const pct = gasPerMile > 0 ? Math.round((Math.abs(gasPerMile - elecPerMile) / gasPerMile) * 100) : 0;
    // The sub always describes the CURRENT selection (updates live with the
    // slider), so it never disagrees with the price shown for it just below.
    sub.textContent = v === "worth"
      ? `Like ${money(equivDisp, cur)}${gasUnit} gas, ${pct}% cheaper`
      : v === "gas"
        ? `Like ${money(equivDisp, cur)}${gasUnit} gas, ${pct}% pricier`
        : `About the same as gas (~${money(equivDisp, cur)}${gasUnit})`;

    detailLine.hidden = false;
    detailLine.textContent = showEffective
      ? `Effective ${money(effective, cur)}/kWh${hasFees ? " incl. fees" : ""} \u00b7 break-even ${money(be, cur)}`
      : `You pay ${money(m.yourRate, cur)} \u00b7 break-even ${money(be, cur)}/kWh`;

    // "How long" at a glance, using your saved battery / power / charge target.
    if (!showBriefly && v !== "gas" && Number.isFinite(session.minutes) && session.minutes > 0) {
      timeline.hidden = false;
      timeline.textContent = `Est. ${formatDuration(session.minutes)} to ${Math.round(session.soc)}% at ${round(m.powerKw, 2)} kW`;
    } else {
      timeline.hidden = true;
    }

    // Time-of-day suggestion based on the current clock time.
    if (rateMode === "tod" && schedule && schedule.length) {
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
    // tiers), keep the verdict and surface the sweet spot in a distinct green
    // block (miles + saving). Otherwise fall back to the plain worth-limit note
    // (time fee) or hide it. The "Charge for" slider answers "how far can I go."
    worthTip.hidden = true;
    if (sweet) {
      timeNote.hidden = true;
      worthTip.hidden = false;
      $("worthTipLead").textContent = `\uD83D\uDCA1 Best value: charge about ${formatDuration(sweet.min)}`;
      $("worthTipSub").textContent = `~${sweet.range} ${sweet.rangeUnit} \u00b7 like ${sweet.equiv}${sweet.unit} gas, ${sweet.pct}% cheaper`;
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

  renderAdvanced(m, be, cur, session, effective, timeFee);
  updatePresetActive();
  persistFrom(m);
}

// Highlight the charger-speed preset that matches the current power, if any.
function updatePresetActive() {
  const kw = parseNum($("powerKw").value);
  for (const btn of document.querySelectorAll("#powerPresets .preset")) {
    const match = Number.isFinite(kw) && Math.abs(parseNum(btn.dataset.kw) - kw) < 0.05;
    btn.classList.toggle("is-active", match);
  }
}

// The "Charge for" slider spans 0 to the full-charge time. It only shows when a
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
  const distDisp = prefs.units === "metric" ? U.kmFromMiles(distMiles) : distMiles;
  return {
    min: stopMin,
    soc: Math.round(best.soc),
    range: Math.round(distDisp),
    rangeUnit: U.labels(prefs.units).distance,
    equiv: money(equivDisp, cur),
    unit: prefs.units === "metric" ? "/L" : "/gal",
    pct,
  };
}

// time fee makes a shorter charge worth considering. Untouched, it sits at the
// full charge so nothing changes; drag it back to price a partial top-up.
function updateChargeSlider(show, fullChargeMin, curMin, curSoc, hasTimeFeeContext = true) {
  const field = $("chargeForField");
  field.hidden = !show;
  if (!show) return;
  const slider = $("chargeForMin");
  const maxMin = Math.max(15, Math.ceil(fullChargeMin));
  slider.max = String(maxMin);
  slider.value = String(capTouched
    ? Math.max(0, Math.min(maxMin, Math.round(chargeCapMin)))
    : maxMin);
  $("chargeForOut").textContent = `${formatDuration(Number(slider.value))} (~${Math.round(curSoc)}%)`;
  $("chargeForNote").textContent = Number(slider.value) >= maxMin - 0.5
    ? "Full charge to your target."
    : (hasTimeFeeContext
        ? "Stopping early: less energy, but less time fee."
        : "Stopping early: less energy, and you skip the pricier later rate.");
}

function renderAdvanced(m, be, cur, session, effective, timeFee) {
  // Lead with range added (the tangible benefit), keep kWh for pricing context.
  const kwhIn = session.kwhIntoBattery;
  if (Number.isFinite(kwhIn) && kwhIn > 0) {
    const kwhStr = `${kwhIn.toFixed(1)} kWh`;
    if (Number.isFinite(m.miPerKwh) && m.miPerKwh > 0) {
      const dist = m.miPerKwh * kwhIn; // canonical miles
      const distDisp = prefs.units === "metric" ? U.kmFromMiles(dist) : dist;
      $("advKwh").textContent = `${Math.round(distDisp)} ${U.labels(prefs.units).distance} \u00b7 ${kwhStr}`;
    } else {
      $("advKwh").textContent = kwhStr;
    }
  } else {
    $("advKwh").textContent = "-";
  }
  $("advTime").textContent = formatDuration(session.minutes);
  const tfRow = $("advTimeFeeRow");
  if (timeFee > 0) {
    tfRow.hidden = false;
    $("advTimeFee").textContent = money(timeFee, cur);
  } else {
    tfRow.hidden = true;
  }
}

// --- Units toggle ---
function applyUnitLabels() {
  const L = U.labels(prefs.units);
  const cur = prefs.currency;
  $("unitToggle").textContent = prefs.units === "metric" ? "Metric" : "Imperial";
  $("gasPriceLabel").textContent = `Gas price (${cur}/${L.gasVolume})`;
  $("yourRateLabel").textContent = `Energy rate (${cur}/kWh)`;
  $("mpgLabel").textContent = `Gas ${L.fuelEconomy}`;
  $("effLabel").textContent = `Electric ${L.evEfficiency}`;
}

function writeDisplayValues() {
  const s = prefs.units;
  $("gasPrice").value = fixed2(U.gasPriceForDisplay(prefs.gasPrice, s));
  $("yourRate").value = fixed2(prefs.yourRate);
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
}

function round(n, d) {
  if (!Number.isFinite(n)) return "";
  const f = Math.pow(10, d);
  return String(Math.round(n * f) / f);
}

// Currency-style fixed 2-decimal display (e.g., 0.3 -> "0.30"); blank if unset.
function fixed2(n) {
  return Number.isFinite(n) ? n.toFixed(2) : "";
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

// Build the TOU schedule from the editor rows: [{ start(min), rate }].
function readSchedule() {
  const sched = [];
  for (const r of document.querySelectorAll("#touRows .tou-row")) {
    const t = r.querySelector(".tou-time").value;
    const rate = parseNum(r.querySelector(".tou-rate").value);
    if (!t || !Number.isFinite(rate)) continue;
    const [h, mm] = t.split(":").map(Number);
    sched.push({ start: h * 60 + mm, rate });
  }
  return sched;
}

function addTouRow(time = "00:00", rate = "") {
  const row = document.createElement("div");
  row.className = "tou-row";
  row.innerHTML =
    `<input type="time" class="tou-time" value="${time}" />` +
    `<div class="input-money tou-rate-wrap">` +
    `<span class="input-money__sym">${escapeHtml(prefs.currency)}</span>` +
    `<input type="number" min="0" step="any" inputmode="decimal" class="tou-rate" placeholder="0.30" value="${rate}" />` +
    `</div>` +
    `<button type="button" class="tou-del" aria-label="Remove period">\u00d7</button>`;
  $("touRows").appendChild(row);
}

// Build duration tiers from the editor rows: [{ start(elapsed min), rate }].
function readDurationTiers() {
  const tiers = [];
  for (const r of document.querySelectorAll("#durRows .dur-row")) {
    const min = parseNum(r.querySelector(".dur-min").value);
    const rate = parseNum(r.querySelector(".dur-rate").value);
    if (!Number.isFinite(rate)) continue;
    tiers.push({ start: Number.isFinite(min) ? min : 0, rate });
  }
  return tiers;
}

function addDurRow(min = 0, rate = "") {
  const row = document.createElement("div");
  row.className = "tou-row dur-row";
  row.innerHTML =
    `<div class="dur-after">after <input type="number" min="0" step="any" inputmode="numeric" class="dur-min" value="${min}" /> min</div>` +
    `<div class="input-money tou-rate-wrap">` +
    `<span class="input-money__sym">${escapeHtml(prefs.currency)}</span>` +
    `<input type="number" min="0" step="any" inputmode="decimal" class="dur-rate" placeholder="0.30" value="${rate}" />` +
    `</div>` +
    `<button type="button" class="tou-del" aria-label="Remove tier">\u00d7</button>`;
  $("durRows").appendChild(row);
}

// Build by-the-hour time-fee tiers from the editor rows: [{ start(min), perHour }].
// Each row's start can be entered in hours (default) or minutes; we normalize to
// minutes here so the math and the rest of the app stay in one unit.
function readTimeFee() {
  const tiers = [];
  for (const r of document.querySelectorAll("#timeFeeRows .tf-row")) {
    const num = parseNum(r.querySelector(".tf-start").value);
    const unit = r.querySelector(".tf-start-unit").value; // "hr" | "min"
    const perHour = parseNum(r.querySelector(".tf-rate").value);
    if (!Number.isFinite(perHour) || perHour <= 0) continue;
    const startMin = Number.isFinite(num) ? (unit === "hr" ? num * 60 : num) : 0;
    tiers.push({ start: startMin, perHour });
  }
  return tiers;
}

function addTimeFeeRow(start = 0, perHour = "", unit = "hr") {
  const row = document.createElement("div");
  row.className = "tou-row tf-row";
  row.innerHTML =
    `<div class="dur-after">after <input type="number" min="0" step="any" inputmode="decimal" class="dur-min tf-start" value="${start}" />` +
    `<select class="tf-start-unit" aria-label="Tier start unit">` +
    `<option value="hr"${unit === "hr" ? " selected" : ""}>hr</option>` +
    `<option value="min"${unit === "min" ? " selected" : ""}>min</option>` +
    `</select></div>` +
    `<div class="input-money tou-rate-wrap">` +
    `<span class="input-money__sym">${escapeHtml(prefs.currency)}</span>` +
    `<input type="number" min="0" step="any" inputmode="decimal" class="tf-rate" placeholder="3" value="${perHour}" />` +
    `</div>` +
    `<span class="tf-unit">/hr</span>` +
    `<button type="button" class="tou-del" aria-label="Remove tier">\u00d7</button>`;
  $("timeFeeRows").appendChild(row);
}

// Reflect the selected pricing mode: show the right editor, and disable the flat
// charger-price field when a schedule/tier mode is driving the result instead.
function applyRateMode() {
  $("touEditor").hidden = rateMode !== "tod";
  $("durEditor").hidden = rateMode !== "dur";

  const rateInput = $("yourRate");
  const note = $("rateModeNote");
  const field = rateInput.closest(".field");
  if (rateMode === "flat") {
    rateInput.disabled = false;
    field.classList.remove("is-disabled");
    note.hidden = true;
  } else {
    rateInput.disabled = true;
    field.classList.add("is-disabled");
    note.hidden = false;
    note.textContent = rateMode === "tod"
      ? "Using time-of-day pricing (set in Advanced)."
      : "Using duration-based pricing (set in Advanced).";
  }

  if (rateMode === "tod" && $("touRows").children.length === 0) {
    addTouRow("00:00", "");
    addTouRow("16:00", "");
  }
  if (rateMode === "dur" && $("durRows").children.length === 0) {
    addDurRow(0, "");
    addDurRow(60, "");
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

// --- Units toggle ---
function toggleUnits() {
  // Values in `prefs` are canonical, so we just flip the flag and re-render fields.
  const m = readInputs();
  persistFrom(m); // capture any edits in current units first
  prefs.units = prefs.units === "metric" ? "imperial" : "metric";
  savePrefs(prefs);
  applyUnitLabels();
  writeDisplayValues();
  render();
}

// --- Car selection ---
const CUSTOM_ID = "__custom__";

function setCar(car, { keepCustom = false } = {}) {
  prefs.carId = car.id;
  if (!keepCustom) {
    prefs.mpg = car.mpg;
    prefs.miPerKwh = car.miPerKwh;
    prefs.batteryKwh = car.batteryKwh;
  }
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

function renderCarResults(query) {
  const ul = $("carResults");
  ul.innerHTML = "";

  const custom = document.createElement("li");
  custom.className = "combo__item combo__item--custom";
  custom.dataset.id = CUSTOM_ID;
  custom.setAttribute("role", "option");
  custom.textContent = "\u270F\uFE0F My own car (enter numbers)";
  ul.appendChild(custom);

  const results = filterCars(query);
  for (const car of results) {
    const li = document.createElement("li");
    li.className = "combo__item";
    li.dataset.id = car.id;
    li.setAttribute("role", "option");
    li.textContent = carLabel(car);
    ul.appendChild(li);
  }
  if (!results.length && query.trim()) {
    const none = document.createElement("li");
    none.className = "combo__none";
    none.textContent = "No matches, try a make or model.";
    ul.appendChild(none);
  }

  ul.hidden = false;
  $("carSearch").setAttribute("aria-expanded", "true");
}

function hideCarResults() {
  $("carResults").hidden = true;
  $("carSearch").setAttribute("aria-expanded", "false");
}

// --- Events ---
function attachEvents() {
  const liveIds = ["gasPrice", "yourRate", "mpg", "miPerKwh", "batteryKwh", "sessionFee", "powerKw"];
  for (const id of liveIds) $(id).addEventListener("input", render);

  // Focusing a number field selects its contents ONLY while it still holds its
  // untouched default (e.g. the "0" in a new station-time-rate row), so one
  // keystroke replaces the default. Once you've typed your own value, focusing
  // leaves it alone so you can edit/append instead of wiping it.
  const touchedFields = new WeakSet();
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (el && el.tagName === "INPUT" && el.type === "number") touchedFields.add(el);
  });
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (el && el.tagName === "INPUT" && el.type === "number" && !touchedFields.has(el)) {
      requestAnimationFrame(() => { try { el.select(); } catch (_) { /* ignore */ } });
    }
  });

  // Numbers never need more than 2 decimals: round on commit (blur/Enter).
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el && el.tagName === "INPUT" && el.type === "number" && el.value.trim() !== "") {
      const n = parseFloat(el.value);
      if (Number.isFinite(n)) {
        const rounded = Math.round(n * 100) / 100;
        if (String(rounded) !== el.value) {
          el.value = String(rounded);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
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
    render();
  });

  $("unitToggle").addEventListener("click", toggleUnits);
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
    addTouRow();
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
    addDurRow();
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
    $("powerKw").value = btn.dataset.kw;
    render();
  });

  $("timeFeeAdd").addEventListener("click", () => {
    addTimeFeeRow();
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

  // Info note: show on hover/focus (desktop), tap to pin open (touch).
  {
    const infoBtn = $("carInfoBtn");
    const infoNote = $("carInfoNote");
    let pinned = false;
    const show = (v) => {
      infoNote.hidden = !v;
      infoBtn.setAttribute("aria-expanded", String(v));
    };
    infoBtn.addEventListener("mouseenter", () => show(true));
    infoBtn.addEventListener("mouseleave", () => { if (!pinned) show(false); });
    infoBtn.addEventListener("focus", () => show(true));
    infoBtn.addEventListener("blur", () => { if (!pinned) show(false); });
    infoBtn.addEventListener("click", () => { pinned = !pinned; show(pinned); });
  }

  $("carSearch").addEventListener("focus", (e) => {
    e.target.select();
    renderCarResults(e.target.value === "My own car" ? "" : e.target.value);
  });
  $("carSearch").addEventListener("input", (e) => renderCarResults(e.target.value));
  $("carSearch").addEventListener("blur", () => setTimeout(hideCarResults, 120));
  $("carResults").addEventListener("mousedown", (e) => {
    const li = e.target.closest(".combo__item");
    if (!li) return;
    e.preventDefault(); // select before the input's blur hides the list
    const id = li.dataset.id;
    if (id === CUSTOM_ID) setCustomCar();
    else { const car = getCar(id); if (car) setCar(car); }
    hideCarResults();
    $("carSearch").blur();
  });

  $("carNickname").addEventListener("input", (e) => {
    prefs.customName = e.target.value.trim();
    savePrefs(prefs);
    if (prefs.carId === CUSTOM_ID) {
      $("carName").textContent = prefs.customName || "My car";
    }
  });

  $("resetBtn").addEventListener("click", () => {
    clearPrefs();
    prefs = { ...DEFAULT_PREFS };
    savePrefs(prefs);
    // Reset volatile UI too: pricing mode, schedule/tier rows, info note.
    rateMode = "flat";
    chargeCapMin = null;
    capTouched = false;
    const flatRadio = document.querySelector('input[name="rateMode"][value="flat"]');
    if (flatRadio) flatRadio.checked = true;
    $("touRows").innerHTML = "";
    $("durRows").innerHTML = "";
    $("timeFeeRows").innerHTML = "";
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

async function init() {
  await loadCars();
  attachEvents();
  boot();

  if ("serviceWorker" in navigator) {
    const isLocal = ["localhost", "127.0.0.1", "[::1]", ""].includes(location.hostname);
    if (isLocal) {
      // Local dev: don't let a cached service worker hide file changes. Tear
      // down any existing registration + caches so every reload is fresh.
      navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
      if (self.caches) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
    } else {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {});
    }
  }
}

init();
