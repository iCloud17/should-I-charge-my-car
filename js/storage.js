// storage.js — persist the user's setup in localStorage (no server, no cookies).

const KEY = "sicc.prefs.v1";

// Only STABLE inputs are persisted. Charger-specific values (rate, session fee,
// time-of-day schedule) change at every stop, so we intentionally do NOT save
// them — the user re-enters those on the spot.
const PERSIST_KEYS = [
  "carId", "customName", "mpg", "miPerKwh", "batteryKwh",
  "gasPrice", "units", "currency", "powerKw", "startPct", "targetPct",
];

export const DEFAULT_PREFS = {
  carId: null, // no car chosen yet — the app starts on a clean "pick your car" state
  // Canonical values (MPG, mi/kWh, kWh). Filled in when a car is chosen or entered.
  mpg: null,
  miPerKwh: null,
  batteryKwh: null,
  gasPrice: null, // canonical: currency per gallon (stable — persisted once entered)
  yourRate: null, // currency per kWh at the charger (volatile — NOT persisted)
  customName: "", // user's nickname for a custom car
  units: "imperial", // "imperial" | "metric"
  currency: "$",
  // Advanced — charger fees & session (volatile — NOT persisted).
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
    const toSave = {};
    for (const k of PERSIST_KEYS) toSave[k] = prefs[k];
    localStorage.setItem(KEY, JSON.stringify(toSave));
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
