// main.js — wire inputs → calc → render. Persist to localStorage.

import { breakevenKwhPrice, chargeSession, effectiveKwhPrice, verdict } from "./calc.js";
import * as U from "./units.js";
import { loadPrefs, savePrefs, clearPrefs, DEFAULT_PREFS } from "./storage.js";
import { loadCars, getCar, getCars, carLabel } from "./cars.js";
import { $, parseNum, money, formatDuration, animateValue } from "./ui.js";

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

  // Mode 1: break-even
  const be = breakevenKwhPrice({ gasPrice: m.gasPrice, mpg: m.mpg, miPerKwh: m.miPerKwh });
  animateValue($("breakevenValue"), be, { currency: cur, digits: 2 });

  const card = $("resultCard");
  const v = verdict(m.yourRate, be);
  card.dataset.verdict = Number.isFinite(m.yourRate) ? (v === "unknown" ? "worth" : v) : "worth";

  $("verdictText").textContent = Number.isFinite(be)
    ? `Charging beats gas below ${money(be, cur)} per kWh.`
    : "Enter your car's numbers to see the break-even price.";

  // Compare: your charger price vs break-even
  const compareBox = $("compareBox");
  if (Number.isFinite(m.yourRate) && Number.isFinite(be)) {
    compareBox.hidden = false;
    compareBox.dataset.verdict = v;
    const diff = Math.abs(m.yourRate - be);
    if (v === "worth") {
      $("compareText").textContent = `Worth it — you're ${money(diff, cur)}/kWh under break-even. Charge up.`;
    } else if (v === "gas") {
      $("compareText").textContent = `Skip it — ${money(diff, cur)}/kWh over break-even. Gas is cheaper.`;
    } else {
      $("compareText").textContent = `Basically a wash — right around break-even.`;
    }
  } else {
    compareBox.hidden = true;
  }

  // Advanced: charge session + effective price
  renderAdvanced(m, be, cur);

  persistFrom(m);
}

function renderAdvanced(m, be, cur) {
  const session = chargeSession({
    batteryKwh: m.batteryKwh,
    startPct: m.startPct,
    targetPct: m.targetPct,
    powerKw: m.powerKw,
  });

  const eff = effectiveKwhPrice({
    sessionFee: m.sessionFee,
    ratePerKwh: m.yourRate || 0,
    kwhFromCharger: session.kwhFromCharger,
  });

  $("advKwh").textContent = Number.isFinite(session.kwhIntoBattery)
    ? `${session.kwhIntoBattery.toFixed(1)} kWh`
    : "—";
  $("advTime").textContent = formatDuration(session.minutes);
  $("advEffective").textContent = money(eff, cur);

  const av = $("advVerdict");
  if (Number.isFinite(eff) && Number.isFinite(be)) {
    const vv = verdict(eff, be);
    if (vv === "worth") {
      av.textContent = `✅ Worth charging — all-in ${money(eff, cur)}/kWh beats break-even.`;
      av.style.color = "var(--worth)";
    } else if (vv === "gas") {
      av.textContent = `❌ Not worth it — fees push you to ${money(eff, cur)}/kWh. Use gas.`;
      av.style.color = "var(--gas)";
    } else {
      av.textContent = `≈ Right at break-even (${money(eff, cur)}/kWh) — your call.`;
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
  $("gasPrice").value = round(U.gasPriceForDisplay(prefs.gasPrice, s), 2);
  $("yourRate").value = round(prefs.yourRate, 2);
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
