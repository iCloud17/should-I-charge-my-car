// storage.js - persist the user's setup in localStorage (no server, no cookies).

const KEY = "sicc.prefs.v1";

// Only STABLE inputs are persisted. Charger-specific values (rate, session fee,
// time-of-day schedule) change at every stop, so we intentionally do NOT save
// them - the user re-enters those on the spot.
const PERSIST_KEYS = [
  "carId", "customName", "carOverrides", "mpg", "miPerKwh", "batteryKwh",
  "gasPrice", "units", "currency", "powerKw", "startPct", "targetPct", "themeMode",
];

export const DEFAULT_PREFS = {
  carId: null, // no car chosen yet - the app starts on a clean "pick your car" state
  // Canonical values (MPG, mi/kWh, kWh). Filled in when a car is chosen or entered.
  mpg: null,
  miPerKwh: null,
  batteryKwh: null,
  gasPrice: null, // canonical: currency per gallon (stable - persisted once entered)
  yourRate: null, // currency per kWh at the charger (volatile - NOT persisted)
  customName: "", // user's nickname for a custom car
  carOverrides: {}, // per-car edited numbers: { [carId]: { mpg, miPerKwh, batteryKwh } }
  units: "imperial", // "imperial" (US) | "uk" | "metric" | "kmL"
  currency: "$",
  themeMode: "auto", // "auto" (follows local time) | "light" | "dark"
  // Advanced - charger fees & session (volatile - NOT persisted).
  sessionFee: 0,
  startPct: 0,
  targetPct: 100,
  // The outlet you're plugged into, not a property of the car. Persisted,
  // because the outlet you use most is usually the same one.
  powerKw: 6.6,
};

// A fresh prefs object. DEFAULT_PREFS is a shared constant and carOverrides
// inside it is mutable, so spreading it alone hands out the SAME overrides
// object every time: saving a per-car edit would write straight into the
// defaults, and "Reset everything" would hand those edits back.
export function defaultPrefs() {
  return { ...DEFAULT_PREFS, carOverrides: {} };
}

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultPrefs();
    const parsed = JSON.parse(raw);
    const prefs = { ...DEFAULT_PREFS, ...parsed };
    prefs.currency = safeCurrency(prefs.currency);
    prefs.units = ["imperial", "uk", "metric", "kmL"].includes(prefs.units) ? prefs.units : "imperial";
    prefs.carOverrides = safeOverrides(prefs.carOverrides);
    return prefs;
  } catch {
    return defaultPrefs();
  }
}

// Currency gets interpolated into markup, so keep it a short, HTML-safe symbol.
function safeCurrency(cur) {
  const c = String(cur == null ? "$" : cur).replace(/[<>&"'`]/g, "").trim().slice(0, 3);
  return c || "$";
}

// The slots a per-car override may hold. `powerKw` is LEGACY and inert: it used
// to double as the car's onboard ceiling, nothing reads or writes it now, and
// it's kept only so rolling back to the previous release still finds its data.
// Do not start reusing it - the values in there conflate car and outlet power.
const OVERRIDE_KEYS = ["mpg", "miPerKwh", "batteryKwh", "powerKw"];

// Per-car edited numbers merged back from storage. Keep only finite numeric
// fields and skip prototype-polluting keys, so a tampered store can't inject junk.
function safeOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw)) {
    if (id === "__proto__" || id === "constructor" || id === "prototype") continue;
    if (!v || typeof v !== "object") continue;
    const o = {};
    for (const k of OVERRIDE_KEYS) {
      if (Number.isFinite(v[k])) o[k] = v[k];
    }
    if (Object.keys(o).length) out[id] = o;
  }
  return out;
}

// Fold freshly typed numbers into the override already saved for a car.
// Merge, never replace: a field cleared mid-edit parses as non-finite, and
// writing that through would erase a value the user had already saved.
// Pure, so the rule is testable without a DOM or localStorage.
export function mergeCarOverride(existing, incoming) {
  const base = existing && typeof existing === "object" ? existing : {};
  const next = incoming && typeof incoming === "object" ? incoming : {};
  const out = {};
  for (const k of OVERRIDE_KEYS) {
    if (Number.isFinite(next[k])) out[k] = next[k];
    else if (Number.isFinite(base[k])) out[k] = base[k];
  }
  return out;
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
