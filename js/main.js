// main.js — wire inputs → calc → render. Persist to localStorage.

import { breakevenKwhPrice, chargeSession, effectiveKwhPrice, verdict, rateAtTime, rateAtElapsed, cheapestPeriod, sessionCost } from "./calc.js";
import * as U from "./units.js";
import { loadPrefs, savePrefs, clearPrefs, DEFAULT_PREFS } from "./storage.js";
import { loadCars, getCar, getCars, carLabel } from "./cars.js";
import { $, parseNum, money, formatDuration } from "./ui.js";

let prefs = loadPrefs();
let rateMode = "flat"; // "flat" | "tod" | "dur" (volatile — never persisted)

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
  const hasFees = m.sessionFee > 0;

  // Resolve the ONE active pricing model into a single {session, effective}.
  // tod integrates cost over the clock (starting now); dur integrates over
  // elapsed charging time; flat is a single rate. Modes are mutually exclusive.
  let session = null, effective = NaN, hasRate = false, schedule = null;
  if (rateMode === "tod") {
    schedule = readSchedule();
    if (schedule.length) {
      const rateOf = (clock) => rateAtTime(schedule, clock);
      session = sessionCost({ batteryKwh: m.batteryKwh, startPct: m.startPct, targetPct: m.targetPct, powerKw: m.powerKw, startClockMin: nowMinutes(), rateOf, sessionFee: m.sessionFee });
    }
  } else if (rateMode === "dur") {
    const tiers = readDurationTiers();
    if (tiers.length) {
      const rateOf = (_clock, elapsed) => rateAtElapsed(tiers, elapsed);
      session = sessionCost({ batteryKwh: m.batteryKwh, startPct: m.startPct, targetPct: m.targetPct, powerKw: m.powerKw, startClockMin: 0, rateOf, sessionFee: m.sessionFee });
    }
  }
  if (session) {
    effective = session.effectivePerKwh;
    hasRate = Number.isFinite(effective);
  } else {
    // Flat rate (also the fallback when a schedule/tier list isn't filled in yet).
    session = chargeSession({ batteryKwh: m.batteryKwh, startPct: m.startPct, targetPct: m.targetPct, powerKw: m.powerKw });
    hasRate = Number.isFinite(m.yourRate) && m.yourRate >= 0;
    effective = hasRate ? effectiveKwhPrice({ sessionFee: m.sessionFee, ratePerKwh: m.yourRate, kwhFromCharger: session.kwhFromCharger }) : NaN;
    if (hasRate && !Number.isFinite(effective)) effective = m.yourRate;
  }
  const showEffective = rateMode !== "flat" || hasFees;

  if (!Number.isFinite(be)) {
    card.dataset.verdict = "close";
    headline.textContent = "\u2014";
    sub.textContent = "Enter your car's MPG and mi/kWh to get started.";
    timeline.hidden = true;
    touNote.hidden = true;
  } else if (!hasRate) {
    // No charger price yet — the break-even IS the headline answer.
    card.dataset.verdict = "worth";
    headline.textContent = `${money(be, cur)}/kWh`;
    sub.textContent = "Break-even price. Enter the charger's price for a yes/no.";
    timeline.hidden = true;
    touNote.hidden = true;
  } else {
    const v = verdict(effective, be);
    card.dataset.verdict = v === "unknown" ? "close" : v;
    headline.textContent = v === "worth" ? "\u26A1 Charge it" : v === "gas" ? "\u26FD Use gas" : "\u2248 Toss-up";
    sub.textContent = showEffective
      ? `Effective ${money(effective, cur)}/kWh${hasFees ? " incl. fees" : ""} \u00b7 break-even ${money(be, cur)}`
      : `You pay ${money(m.yourRate, cur)} \u00b7 break-even ${money(be, cur)}/kWh`;

    // "How long" at a glance, using your saved battery / power / charge target.
    if (v !== "gas" && Number.isFinite(session.minutes) && session.minutes > 0) {
      timeline.hidden = false;
      timeline.textContent = `~${formatDuration(session.minutes)} to ${m.targetPct}% at ${round(m.powerKw, 1)} kW`;
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
  }

  renderAdvanced(m, be, cur, session, effective);
  persistFrom(m);
}

function renderAdvanced(m, be, cur, session, effective) {
  $("advKwh").textContent = Number.isFinite(session.kwhIntoBattery)
    ? `${session.kwhIntoBattery.toFixed(1)} kWh`
    : "—";
  $("advTime").textContent = formatDuration(session.minutes);
  $("advEffective").textContent = money(effective, cur);

  const av = $("advVerdict");
  if (Number.isFinite(effective) && Number.isFinite(be)) {
    const vv = verdict(effective, be);
    if (vv === "worth") {
      av.textContent = `✅ Worth charging — all-in ${money(effective, cur)}/kWh beats break-even.`;
      av.style.color = "var(--worth)";
    } else if (vv === "gas") {
      av.textContent = `❌ Not worth it — fees push you to ${money(effective, cur)}/kWh. Use gas.`;
      av.style.color = "var(--gas)";
    } else {
      av.textContent = `≈ Right at break-even (${money(effective, cur)}/kWh) — your call.`;
      av.style.color = "var(--close)";
    }
  } else {
    av.textContent = "Add a charger price to compare.";
    av.style.color = "var(--muted)";
  }
}

// --- Units toggle ---
function applyUnitLabels() {
  const L = U.labels(prefs.units);
  $("unitToggle").textContent = prefs.units === "metric" ? "Metric" : "Imperial";
  $("gasPriceLabel").textContent = `Gas price (${L.gasVolume})`;
  $("mpgLabel").textContent = `Gas ${L.fuelEconomy}`;
  $("effLabel").textContent = `Electric ${L.evEfficiency}`;
}

function writeDisplayValues() {
  const s = prefs.units;
  $("gasPrice").value = fixed2(U.gasPriceForDisplay(prefs.gasPrice, s));
  $("yourRate").value = fixed2(prefs.yourRate);
  $("mpg").value = round(U.economyForDisplay(prefs.mpg, s), 1);
  $("miPerKwh").value = round(U.efficiencyForDisplay(prefs.miPerKwh, s), 2);
  $("batteryKwh").value = round(prefs.batteryKwh, 1);
  $("sessionFee").value = round(prefs.sessionFee, 2);
  $("powerKw").value = round(prefs.powerKw, 1);
  $("startPct").value = prefs.startPct;
  $("targetPct").value = prefs.targetPct;
  $("startPctOut").textContent = `${prefs.startPct}%`;
  $("targetPctOut").textContent = `${prefs.targetPct}%`;
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
    `<span class="input-money__sym">${prefs.currency}</span>` +
    `<input type="text" inputmode="decimal" class="tou-rate" placeholder="0.30" value="${rate}" />` +
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
    `<div class="dur-after">after <input type="text" inputmode="numeric" class="dur-min" value="${min}" /> min</div>` +
    `<div class="input-money tou-rate-wrap">` +
    `<span class="input-money__sym">${prefs.currency}</span>` +
    `<input type="text" inputmode="decimal" class="dur-rate" placeholder="0.30" value="${rate}" />` +
    `</div>` +
    `<button type="button" class="tou-del" aria-label="Remove tier">\u00d7</button>`;
  $("durRows").appendChild(row);
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
  $("nicknameField").hidden = true;
  $("carSelect").value = car.id;
  writeDisplayValues();
  render();
}

// Switch to a user-defined car: keep the current numbers, drive the label from
// the nickname, and reveal the name field so it's obvious where to enter it.
function setCustomCar() {
  prefs.carId = CUSTOM_ID;
  savePrefs(prefs);
  $("carName").textContent = prefs.customName || "My car";
  $("nicknameField").hidden = false;
  $("carSelect").value = CUSTOM_ID;
  $("carTile").open = true;
  writeDisplayValues();
  render();
  $("carNickname").focus();
}

function buildCarSelect() {
  const sel = $("carSelect");
  sel.innerHTML = "";
  const custom = document.createElement("option");
  custom.value = CUSTOM_ID;
  custom.textContent = "\u270F\uFE0F  My own car (enter numbers)";
  if (prefs.carId === CUSTOM_ID) custom.selected = true;
  sel.appendChild(custom);
  for (const car of getCars()) {
    const opt = document.createElement("option");
    opt.value = car.id;
    opt.textContent = carLabel(car);
    if (car.id === prefs.carId) opt.selected = true;
    sel.appendChild(opt);
  }
}

// --- Events ---
function attachEvents() {
  const liveIds = ["gasPrice", "yourRate", "mpg", "miPerKwh", "batteryKwh", "sessionFee", "powerKw"];
  for (const id of liveIds) $(id).addEventListener("input", render);

  $("startPct").addEventListener("input", (e) => {
    $("startPctOut").textContent = `${e.target.value}%`;
    render();
  });
  $("targetPct").addEventListener("input", (e) => {
    $("targetPctOut").textContent = `${e.target.value}%`;
    render();
  });

  $("unitToggle").addEventListener("click", toggleUnits);

  // Pricing mode (flat / time-of-day / duration) — exclusive, not persisted.
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

  $("carSelect").addEventListener("change", (e) => {
    const val = e.target.value;
    if (val === CUSTOM_ID) {
      setCustomCar();
    } else {
      const car = getCar(val);
      if (car) setCar(car);
    }
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
    boot();
  });
}

// --- Boot ---
function boot() {
  applyUnitLabels();
  buildCarSelect();
  if (prefs.carId === CUSTOM_ID) {
    $("carName").textContent = prefs.customName || "My car";
    $("nicknameField").hidden = false;
  } else {
    const car = getCar(prefs.carId) || getCars()[0];
    if (car) {
      $("carName").textContent = `${car.make} ${car.model}`;
      $("carSelect").value = car.id;
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
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
}

init();
