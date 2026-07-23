// main.js — wire inputs → calc → render. Persist to localStorage.

import { breakevenKwhPrice, chargeSession, effectiveKwhPrice, verdict } from "./calc.js";
import * as U from "./units.js";
import { loadPrefs, savePrefs, clearPrefs, DEFAULT_PREFS } from "./storage.js";
import { loadCars, getCar, getCars, carLabel } from "./cars.js";
import { $, parseNum, money, formatDuration } from "./ui.js";

let prefs = loadPrefs();

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
  const hasRate = Number.isFinite(m.yourRate) && m.yourRate >= 0;

  // Charge session + all-in effective price (energy + session fee amortized over
  // the kWh actually added). The hero uses this, so Advanced fees flow up to it.
  const session = chargeSession({ batteryKwh: m.batteryKwh, startPct: m.startPct, targetPct: m.targetPct, powerKw: m.powerKw });
  let effective = NaN;
  if (hasRate) {
    effective = effectiveKwhPrice({ sessionFee: m.sessionFee, ratePerKwh: m.yourRate, kwhFromCharger: session.kwhFromCharger });
    if (!Number.isFinite(effective)) effective = m.yourRate; // no energy to add
  }
  const hasFees = m.sessionFee > 0;

  if (!Number.isFinite(be)) {
    card.dataset.verdict = "close";
    headline.textContent = "\u2014";
    sub.textContent = "Enter your car's MPG and mi/kWh to get started.";
    timeline.hidden = true;
  } else if (!hasRate) {
    // No charger price yet — the break-even IS the headline answer.
    card.dataset.verdict = "worth";
    headline.textContent = `${money(be, cur)}/kWh`;
    sub.textContent = "Break-even price. Enter the charger's price for a yes/no.";
    timeline.hidden = true;
  } else {
    const v = verdict(effective, be);
    card.dataset.verdict = v === "unknown" ? "close" : v;
    headline.textContent = v === "worth" ? "\u26A1 Charge it" : v === "gas" ? "\u26FD Use gas" : "\u2248 Toss-up";
    sub.textContent = hasFees
      ? `Effective ${money(effective, cur)}/kWh incl. fees · break-even ${money(be, cur)}`
      : `You pay ${money(m.yourRate, cur)} · break-even ${money(be, cur)}/kWh`;

    // "How long" at a glance, using your saved battery / power / charge target.
    if (v !== "gas" && Number.isFinite(session.minutes) && session.minutes > 0) {
      timeline.hidden = false;
      timeline.textContent = `~${formatDuration(session.minutes)} to ${m.targetPct}% at ${round(m.powerKw, 1)} kW`;
    } else {
      timeline.hidden = true;
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
  $("carName").textContent = `${car.model}`;
  writeDisplayValues();
  render();
}

// Switch to a user-defined car: keep the current numbers, drive the label from
// the nickname, and open the editor so it's obvious where to enter values.
function setCustomCar() {
  prefs.carId = CUSTOM_ID;
  savePrefs(prefs);
  $("carName").textContent = prefs.customName || "My car";
  $("customize").open = true;
  writeDisplayValues();
  render();
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

  const dialog = $("carDialog");
  $("carButton").addEventListener("click", () => {
    buildCarSelect();
    dialog.showModal();
  });
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "pick") {
      const val = $("carSelect").value;
      if (val === CUSTOM_ID) {
        setCustomCar();
      } else {
        const car = getCar(val);
        if (car) setCar(car);
      }
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
  if (prefs.carId === CUSTOM_ID) {
    $("carName").textContent = prefs.customName || "My car";
  } else {
    const car = getCar(prefs.carId) || getCars()[0];
    if (car) $("carName").textContent = car.model;
  }
  writeDisplayValues();
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
