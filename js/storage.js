// storage.js — persist the user's setup in localStorage (no server, no cookies).

const KEY = "sicc.prefs.v1";

export const DEFAULT_PREFS = {
  carId: "rav4-prime-2023",
  // Canonical values (MPG, mi/kWh, kWh). Populated from the chosen car but
  // overridable by the user; we store them so custom edits survive reloads.
  mpg: 38,
  miPerKwh: 2.9,
  batteryKwh: 18.1,
  gasPrice: 3.89, // canonical: currency per gallon
  yourRate: 0.30, // currency per kWh the charger charges
  units: "imperial", // "imperial" | "metric"
  currency: "$",
  // Advanced (Mode 2) — flat rate + fees + charge session.
  sessionFee: 0,
  idleFeePerHour: 0,
  powerKw: 6.6,
  startPct: 20,
  targetPct: 100,
};

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable (private mode); app still works, just won't persist */
  }
}

export function clearPrefs() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
