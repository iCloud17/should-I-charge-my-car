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
  // Advanced - charger fees & session.
  sessionFee: 0, // volatile - NOT persisted, it changes at every stop
  // These two ARE in PERSIST_KEYS and do come back next visit, despite sitting
  // next to sessionFee. Whether they should persist is an open product question.
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

// The number fields that describe the CAR, so editing one saves an override
// keyed to the current car. This is the single source of truth: main.js watches
// exactly these inputs and applyCarEdit copies exactly these fields, so the list
// can't drift between the two.
//
// powerKw is deliberately absent. It's the OUTLET you're standing at, not a
// property of the car, and putting it back here writes a station's power into
// the car's saved numbers, where it later reads as the car's own ceiling.
export const CAR_EDIT_FIELDS = ["mpg", "miPerKwh", "batteryKwh"];

// Remember a per-car number edit: merge the car-scoped fields of `inputs` into
// the override saved for `carId` and return the prefs to store. Only
// CAR_EDIT_FIELDS are read from `inputs`, so anything else in the live model
// (the outlet power, the gas price, a charger fee) can never reach a car.
// Pure: returns new prefs, never mutates what it was given.
export function applyCarEdit(prefs, carId, inputs) {
  if (!carId) return prefs;
  const src = inputs && typeof inputs === "object" ? inputs : {};
  const incoming = {};
  for (const k of CAR_EDIT_FIELDS) incoming[k] = src[k];
  const existing = prefs.carOverrides && typeof prefs.carOverrides === "object" ? prefs.carOverrides : {};
  return {
    ...prefs,
    carOverrides: { ...existing, [carId]: mergeCarOverride(existing[carId], incoming) },
  };
}

// Picking a car fills in its numbers, preferring any the user has edited for it.
//
// powerKw is deliberately NOT touched. The car's onboard ceiling belongs where
// the number is used (see carCeilingKw), never written back into storage:
// clamping on the way in only ratchets down, so picking one 3.3 kW car would
// leave the outlet field stuck at 3.3 for every car chosen afterwards.
// Pure: returns new prefs, never mutates what it was given.
export function applyCarSelection(prefs, car) {
  const all = prefs.carOverrides && typeof prefs.carOverrides === "object" ? prefs.carOverrides : {};
  const ov = all[car.id];
  const pick = (k) => (ov && typeof ov === "object" && Number.isFinite(ov[k]) ? ov[k] : car[k]);
  return {
    ...prefs,
    carId: car.id,
    mpg: pick("mpg"),
    miPerKwh: pick("miPerKwh"),
    batteryKwh: pick("batteryKwh"),
  };
}

// Fold one render pass's canonical model values back into prefs, giving exactly
// the object that gets saved.
//
// powerKw is stored EXACTLY as the user typed it. The car's onboard cap is
// applied downstream, where the number is used; a capped value must never reach
// this function, or the cap ratchets into storage and outlives the car.
// Pure: returns new prefs, never mutates what it was given.
export function persistableFrom(prefs, m) {
  return {
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

// "Reset everything": drop what's stored and hand back a genuinely fresh set.
// The clear/build/save sequence lives here so the freshness rule has one home.
// It must build through defaultPrefs(): spreading DEFAULT_PREFS hands out the
// shared carOverrides object, so the next per-car edit writes into the defaults
// and the reset after that gives the user their old overrides straight back.
export function resetPrefs() {
  clearPrefs();
  const prefs = defaultPrefs();
  savePrefs(prefs);
  return prefs;
}
