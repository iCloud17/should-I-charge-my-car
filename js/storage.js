// storage.js - persist the user's setup in localStorage (no server, no cookies).

import { MAX_OUTLET_KW } from "./cars.js";

const KEY = "sicc.prefs.v1";

// Only STABLE inputs are persisted. Charger-specific values (rate, session fee,
// time-of-day schedule) change at every stop, so we intentionally do NOT save
// them - the user re-enters those on the spot.
//
// Exported because it is also the whitelist on the way back IN: sanitizePrefs
// reads these keys and no others, so the two directions cannot drift apart.
export const PERSIST_KEYS = [
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
    return sanitizePrefs(JSON.parse(raw));
  } catch {
    return defaultPrefs();
  }
}

// --- Reading back: a stored prefs object is untrusted input -----------------
//
// localStorage is fully user-editable, so what comes back is untrusted input
// rather than our own data coming home. Every persisted key gets a rule below,
// and a value that fails its rule is DROPPED so the documented default takes
// its place.
//
// Numbers are dropped, never repaired. A repaired number is one the user never
// chose, and the next render reads it back out of the field and saves it, so the
// invention becomes their setting. A stored startPct of null did exactly that:
// a range input cannot hold null, falls back to the midpoint of its own min and
// max, and the app came up claiming a 50% starting charge and then wrote the 50
// to storage. Absent beats confidently wrong. A blank field asks a question; a
// fabricated number answers one.
//
// Text is narrowed rather than dropped, which is a different thing from
// repairing: cleanText strips control characters and truncates, safeCurrency
// strips markup characters and falls back to "$". Each takes something away from
// what was stored; none of them invents a value the user never had.
//
// One number does still get repaired, just not in here. See the startPct and
// targetPct rule below for an ordering fix-up that happens downstream and is
// written back to storage.
//
// Dropped per field, too. safeOverrides already works this way and it is the
// right discipline: one tampered number must not cost the user the car, the
// currency and the gas price they legitimately saved.

// The unit systems the app can label and convert.
const UNIT_SYSTEM_IDS = ["imperial", "uk", "metric", "kmL"];

// Text caps. The longest id in the bundled dataset is 59 characters, so 128 is
// slack rather than a tight fit. 40 matches the nickname input's maxlength,
// which is only a DOM hint and a tampered store walks straight past it.
const MAX_CAR_ID_LEN = 128;
const MAX_CUSTOM_NAME_LEN = 40;

// C0 and C1 control characters survive JSON and reach the page through
// textContent and input values, where they render as nothing or as broken
// layout. Stripped rather than rejected, so one stray byte costs a character
// instead of the whole nickname.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

function cleanText(v, max) {
  if (typeof v !== "string") return undefined;
  return v.replace(CONTROL_CHARS, "").trim().slice(0, max);
}

// A quantity the app divides by, prices against, or charges into. Zero is
// rejected along with the rest: a zero battery, economy or gas price is not a
// setting anyone means, and it propagates as a division by zero or as a verdict
// with nothing behind it.
function positiveNumber(v) {
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

// A state of charge, on the sliders' own 0 to 100 scale. Zero IS valid here:
// an empty battery is a real place to start from.
function percent(v) {
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined;
}

// One rule per persisted key. A rule returns the value to use, or undefined to
// drop the key. Every key in PERSIST_KEYS must appear here; a test pins that,
// because a key with no rule is a key nothing checks.
const PREF_RULES = {
  // Reaches getCar and, as a computed key, carOverrides. The computed-key form
  // is what keeps a carId of "__proto__" from reparenting that object, and
  // safeOverrides skips those keys on the way back in, so what is left to fix
  // is the size and the content: a string, no control characters, bounded.
  carId: (v) => cleanText(v, MAX_CAR_ID_LEN) || undefined,
  customName: (v) => cleanText(v, MAX_CUSTOM_NAME_LEN),
  carOverrides: safeOverrides,

  // The canonical numbers. safeOverrides already holds the per-car copies to
  // finite; these top-level mirrors are the ones that were taken on trust.
  mpg: positiveNumber,
  miPerKwh: positiveNumber,
  batteryKwh: positiveNumber,
  gasPrice: positiveNumber,

  // The outlet, held to the same AC ceiling the estimate uses. Dropped when it
  // is out of range rather than clamped to MAX_OUTLET_KW, because clamping
  // hands back a socket the user never plugged into and the next render saves
  // it. Dropping restores the documented 6.6 default, and since the ceiling is
  // a constant it lands there once instead of ratcheting down over sessions.
  powerKw: (v) => (Number.isFinite(v) && v > 0 && v <= MAX_OUTLET_KW ? v : undefined),

  units: (v) => (UNIT_SYSTEM_IDS.includes(v) ? v : undefined),
  currency: safeCurrency,

  // Checked independently, and their ORDER is deliberately not checked here.
  // A start above a target is two individually valid numbers in a surprising
  // arrangement, not garbage, and picking one to overwrite would invent a
  // relationship the user never expressed.
  //
  // That restraint ends at this function. writeDisplayValues pulls the start
  // down to the target while hydrating the sliders, and the render right behind
  // it reads the slider back and saves it: seed 90/20 and localStorage holds
  // 20/20 after one load, with the 90 gone. That is the repair, read back, save
  // loop this file argues against everywhere else, and it is the one case the
  // rule at the top does not cover.
  //
  // Left alone deliberately, NOT because it is handled. It predates this branch
  // and ships on main today, and what a start above a target should do (clamp
  // the start, raise the target, refuse the pair, say something) is an open
  // product question nobody has answered. chargeCurve's empty result is a real
  // guard, but only for a crossed pair that reaches it uncorrected; on the load
  // path the slider fix-up has already happened.
  startPct: percent,
  targetPct: percent,

  // Identity on purpose. theme.js already treats anything that is not "light"
  // or "dark" as auto, in resolveTheme, nextThemeMode and themeLabel alike, so
  // a tampered value paints as auto, labels as Auto and cycles back to auto. A
  // second rule here would be the same decision with two homes and no extra
  // safety.
  themeMode: (v) => v,
};

// Turn whatever was parsed out of storage into prefs the app can use. Pure: no
// DOM and no localStorage, so every rule above is testable on its own and
// loadPrefs stays a thin read-and-parse wrapper.
//
// Only PERSIST_KEYS are read, so a store that has grown extra keys cannot push
// them into prefs. That matters for the deliberately unpersisted ones: without
// the whitelist, a hand-edited yourRate or sessionFee would load as if the app
// had saved it.
export function sanitizePrefs(parsed) {
  const raw = parsed && typeof parsed === "object" ? parsed : {};
  const prefs = defaultPrefs();
  for (const k of PERSIST_KEYS) {
    const rule = PREF_RULES[k];
    const v = rule ? rule(raw[k]) : undefined; // no rule means no trust
    if (v !== undefined) prefs[k] = v;
  }
  return prefs;
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
