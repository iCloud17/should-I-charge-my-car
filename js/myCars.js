// myCars.js - the user's saved cars, in their own localStorage key.
//
// SEPARATE KEY, SEPARATE MODULE, and the separation is the feature. savePrefs
// REBUILDS its payload from PERSIST_KEYS on every write and persistFrom runs at
// the end of every render, so any build whose whitelist does not name a key
// deletes that key within milliseconds of loading. service-worker.js serves
// cache after a 2500ms network timeout, which makes "a stale build is running"
// an ordinary state on a weak charger signal rather than an edge case. Nesting
// saved cars inside sicc.prefs.v1 would therefore hand a cached old build a
// working mechanism for destroying them. It cannot destroy a key it never
// enumerates.
//
// The module boundary mirrors the key boundary on purpose: nothing in the prefs
// read/write path imports this file, and this file never touches sicc.prefs.v1.
//
// sicc.prefs.v1 and carOverrides stay intact and keep being written for one
// release. They are the rollback, not dead weight.
//
// The rules live in pure functions (sanitizeCarsPayload, migrateCars, addMyCar,
// removeMyCar, setActiveMyCar) with load/save as thin wrappers, because a rule
// that a test cannot import is a rule nothing holds.

import {
  CAR_EDIT_FIELDS, cleanText, positiveNumber,
  MAX_CAR_ID_LEN, MAX_CUSTOM_NAME_LEN,
} from "./storage.js";
import { carCeilingKw } from "./cars.js";

const CARS_KEY = "sicc.cars.v1";

// The version lives IN the payload, not only in the key name. The key says
// which store this is; `v` says which shape is inside it. A build that finds a
// higher `v` than it understands reads what it can and refuses to write, which
// degrades to read-only instead of overwriting a newer build's data with an
// older build's understanding of it.
export const CARS_V = 1;

// Five, per the accepted decision. The cap is enforced on the way IN (addMyCar
// refuses and says why) and again on the way back OUT of storage, because a
// hand-edited store walks past the first one.
export const MAX_MY_CARS = 5;

// A saved car's numbers are the same three quantities main.js already treats as
// car-shaped, so the list is imported rather than restated. Drift between two
// copies of this list is what would let a car save a field no editor writes.
const CAR_NUMBER_KEYS = CAR_EDIT_FIELDS;

// The label is a snapshot of "2025 Chrysler Pacifica Hybrid" at the moment the
// car was saved. Longest in the bundled dataset is well under this.
const MAX_LABEL_LEN = 64;

// Opaque, locally generated, and deliberately NOT carId. Three separate reasons
// and each one is sufficient on its own: two saved cars must be able to share a
// carId (that is the entire point of the feature), the custom sentinel
// collapses every custom car into one slot, and carId is dataset-derived so
// scripts/seed.mjs can change it on a reseed and orphan the record.
//
// Lowercase alphanumeric only, which is what makes "__proto__" fail as an id
// before any object is built from it.
const ID_RE = /^[a-z0-9]{1,32}$/;

// "constructor" and "prototype" PASS the charset above, which is exactly why
// they are named separately. Only "__proto__" is excluded by the regex, and a
// charset that happens to exclude one of the three reads like a guard while
// covering a third of the problem.
//
// Nothing here keys an object by id today (dedupe uses a Set, selection uses a
// scan), so this is not closing a live hole. It is refusing to leave one for
// the UI layer, where `byId[car.id]` is the obvious thing to write and would
// reparent its lookup table without any other change.
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Invisible and direction-changing characters, stripped from anything the user
// types that names a car.
//
// The bidi controls are the ones that matter HERE specifically, more than in
// any other field in this app. They reorder rendered text, so two saved cars
// can be made to paint identically while holding different numbers. This
// feature exists so a user can tell near-identical cars apart, and a control
// character that defeats that defeats the feature, not just the display.
//
// Zero-width and soft hyphen are in the same set for the plainer reason: they
// survive JSON, render as nothing, and make two names that look equal compare
// unequal.
const INVISIBLE_CHARS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

// A user-facing car name, narrowed rather than dropped, the same way the prefs
// sanitizer narrows text: each step takes something away, none invents a value
// the user never had.
//
// Built ON TOP of cleanText rather than beside it. cleanText owns the control
// character rule and the cap, and this adds the three steps a name needs that
// an id does not. Restating cleanText here would create the second site that
// quietly redefines the contract.
//
// Order is load bearing. NFC first, so the cap counts characters the user would
// recognise and two spellings of the same name compare equal. Invisible strip
// next, so a name built only from them collapses to empty rather than to
// whitespace. Whitespace collapse before the cap, so padding cannot push real
// characters past it.
export function cleanName(v, max) {
  if (typeof v !== "string") return "";
  const flat = v.normalize("NFC").replace(INVISIBLE_CHARS, "").replace(/\s+/g, " ");
  return cleanText(flat, max);
}

// --- The onboard maximum: a snapshot, and never a cache ---------------------
//
// maxKw is the car's rated onboard charge power, copied from the dataset's
// chargeKw at the moment the car is saved. It is here for the same reason label
// is: scripts/seed.mjs can change or drop a carId on a reseed, and an orphaned
// car has to keep working. A stale label is cosmetic. A lost ceiling is not:
// carCeilingKw answers Infinity, MAX_OUTLET_KW becomes the only bound, and the
// charge-time estimate comes out optimistic, which is a wrong answer wearing
// the app's own authority.
//
// IT IS NOT THE OUTLET. The field this replaces, the per-car powerKw an older
// release wrote into carOverrides, conflated the two, and that conflation is
// the shape of three of this week's defects. Two things keep them apart, and
// both are structural rather than remembered:
//
//   maxKw is absent from CAR_EDIT_FIELDS, so the loop that copies the
//   user-editable numbers into a saved car cannot reach this key; and
//
//   datasetChargeKw is the only source, it reads a dataset row and nothing
//   else, and both callers set the key AFTER spreading whatever they were
//   handed, so a draft or a legacy override carrying its own maxKw is
//   overwritten rather than trusted.
//
// Absent is legal. A custom car has no dataset row, so it has no snapshot and
// stays bounded only by MAX_OUTLET_KW, which is exactly today's behavior.

// A dataset row for a carId, or null when the dataset cannot answer. Never
// throws: the dataset is fetched at startup and may not have arrived, and a
// lookup that fails must cost the snapshot rather than the car.
//
// Returns the ROW rather than the number on purpose. "There is no row for this
// car" and "the row exists and carries no figure" are different answers, and
// savedCarCeilingKw turns on exactly that difference.
//
// The callable check is stated rather than discovered, matching labelOf below.
// No test can hold it: calling a non-function throws inside the try and the
// catch returns the same null. It is here to say what this takes, and it is a
// known mutation survivor for that reason rather than an unnoticed gap.
function datasetCar(getCar, carId) {
  if (typeof getCar !== "function" || !carId) return null;
  try {
    const row = getCar(carId);
    return row && typeof row === "object" ? row : null;
  } catch {
    return null;
  }
}

// The only reader of the dataset's figure, called at create and at migrate and
// nowhere else. Returns what the row says, unnarrowed: safeCar holds maxKw to
// positiveNumber and both callers route through it, so narrowing here too would
// be a second home for one rule and a guard no test could reach.
function datasetChargeKw(getCar, carId) {
  const row = datasetCar(getCar, carId);
  return row ? row.chargeKw : undefined;
}

// The ceiling for a SAVED car. A different question from the one carCeilingKw
// answers, so it gets a different function rather than a second parameter.
//
// carCeilingKw takes a dataset row and takes nothing else, and its own comment
// says any extra context handed to it must leave the answer unchanged. That
// sentence is load bearing: the last time a second input reached the ceiling it
// was an outlet, and a saved record is a new place one could arrive from. A
// separate function keeps that door shut by construction, because the saved
// record never reaches the dataset rule at all. The dataset rule is still the
// one that answers for a row, delegated to rather than restated, so there is
// one definition of what a row's ceiling is.
//
// THE LIVE DATASET WINS. A carId that resolves is answered by its row,
// including when the row's answer is "no figure", so a reseed that corrects a
// chargeKw takes effect on the next load. The snapshot is consulted only when
// the lookup finds nothing, which is what makes it a fallback and not a cache
// of a number that has moved on.
//
// The stored field is re-checked here rather than assumed clean, because this
// can be handed a record that came from somewhere other than the loader.
export function savedCarCeilingKw(saved, getCar) {
  const row = datasetCar(getCar, saved?.carId);
  if (row) return carCeilingKw(row);
  return positiveNumber(saved?.maxKw) ?? Infinity;
}

// The three numbers to SHOW for a saved car: what the user edited, falling back
// to the dataset row for anything they never touched.
//
// This is the read that makes the cars layer the source of a car's numbers
// while carOverrides keeps being written as the rollback. It has to answer
// exactly what applyCarSelection answers from carOverrides, because anything
// else diverges the two stores the moment a car is picked, and the store that
// is only read on rollback is the one that would then look correct.
//
// So the row's value is passed through UNNARROWED, matching applyCarSelection's
// `car[k]`, and it is assigned even when the row has no figure, because that
// function assigns undefined there too and a blank field is what the user sees.
// Narrowing here would make the two disagree about a car whose row carries a
// junk number.
//
// With NO row the key is left out entirely rather than set to undefined, so a
// caller spreading this over prefs keeps what was already there. That is what a
// custom car needs: it has no row, so an unedited one answers nothing and the
// fields keep whatever the user is looking at.
export function savedCarNumbers(saved, getCar) {
  const row = datasetCar(getCar, saved?.carId);
  const out = {};
  for (const k of CAR_NUMBER_KEYS) {
    const mine = positiveNumber(saved?.[k]);
    if (mine !== undefined) out[k] = mine;
    else if (row) out[k] = row[k];
  }
  return out;
}

// --- Reading back: a saved-cars payload is untrusted input ------------------
//
// Same posture as sanitizePrefs, for the same reason: localStorage is fully
// user-editable, so this is untrusted input rather than our own data coming
// home. This store adds a text field the user controls, which is a wider
// surface than prefs ever had.
//
// Bad cars are dropped INDIVIDUALLY, matching the discipline safeOverrides
// already uses. One tampered entry must not cost the user the four cars they
// legitimately saved.

// A stored id, held to the charset that makes it safe to compare and to key a
// lookup on. Returns undefined rather than a repaired value, because an id the
// app invents points at a car the user did not save.
function safeId(v) {
  if (typeof v !== "string" || RESERVED_KEYS.has(v)) return undefined;
  return ID_RE.test(v) ? v : undefined;
}

// A pointer into the dataset, not the identity. May repeat across cars, may be
// the custom sentinel, may be absent. Carries forward the prototype guard from
// safeOverrides: this value used to key an object there, and a saved car is a
// new place it could start doing so again.
function safeCarId(v) {
  if (RESERVED_KEYS.has(v)) return undefined;
  return cleanText(v, MAX_CAR_ID_LEN) || undefined;
}

// One stored car. Fixed literal keys only: never obj[key] = v and never a
// computed key sourced from the payload, which is what keeps a tampered entry
// from reparenting the object it lands in.
function safeCar(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = safeId(raw.id);
  if (!id) return null;

  const car = {
    id,
    carId: safeCarId(raw.carId) ?? null,
    label: cleanName(raw.label, MAX_LABEL_LEN),
    name: cleanName(raw.name, MAX_CUSTOM_NAME_LEN),
  };
  let numbers = 0;
  for (const k of CAR_NUMBER_KEYS) {
    const n = positiveNumber(raw[k]);
    if (n !== undefined) { car[k] = n; numbers++; }
  }

  // Read outside the loop above, because it is not one of those numbers. Those
  // are what the user typed; this is what the dataset said. Same predicate
  // though, since a second rule for one quantity is this project's recorded
  // defect shape.
  //
  // It does not count toward `numbers` either. A snapshot with no car to apply
  // it to is not a car, and counting it would keep a record alive on the
  // strength of a value the user never entered.
  const snapshot = positiveNumber(raw.maxKw);
  if (snapshot !== undefined) car.maxKw = snapshot;

  // A record with no dataset pointer AND no numbers describes no car: nothing
  // to look up and nothing to calculate with. A record with a carId and no
  // numbers is a real car the user picked and never edited, and it inherits the
  // dataset row, so it stays.
  if (!car.carId && numbers === 0) return null;
  return car;
}

// The raw in-payload version, before any narrowing. Read separately from
// sanitizeCarsPayload because the two answer different questions: this one says
// whether this build is allowed to WRITE, the other says what it may read.
export function payloadVersion(parsed) {
  const v = parsed && typeof parsed === "object" ? parsed.v : undefined;
  return Number.isInteger(v) && v > 0 ? v : 0;
}

// Turn whatever was parsed out of storage into a saved-cars state the app can
// use. Pure: no DOM and no localStorage.
//
// Always reports v as CARS_V, because the returned value is this build's
// understanding of the data. Whether it may be written back is payloadVersion's
// question, answered at the store boundary.
export function sanitizeCarsPayload(parsed) {
  const raw = parsed && typeof parsed === "object" ? parsed : {};
  const list = Array.isArray(raw.cars) ? raw.cars : [];

  const cars = [];
  const seen = new Set();
  for (const entry of list) {
    if (cars.length >= MAX_MY_CARS) break;
    const car = safeCar(entry);
    // A repeated id is not a cosmetic problem: selection resolves by id, so the
    // second car with a given id can never be reached and the first one answers
    // for both. Dropped rather than renamed, because a renamed car is a car the
    // user did not save.
    if (!car || seen.has(car.id)) continue;
    seen.add(car.id);
    cars.push(car);
  }

  return { v: CARS_V, cars, activeId: resolveActiveId(cars, raw.activeId) };
}

// Which car is selected, with the two absent cases kept apart on purpose.
//
// A null or missing activeId means NO car is selected, which is a legal state
// the app already has today (prefs.carId starts null) and must survive a round
// trip. Promoting it to the first car would select a car on the user's behalf.
//
// A non-null activeId that resolves to nothing is a BROKEN pointer, not a
// choice, so it falls back to the first car deterministically.
function resolveActiveId(cars, wanted) {
  if (wanted === null || wanted === undefined) return null;
  if (cars.some((c) => c.id === wanted)) return wanted;
  return cars.length ? cars[0].id : null;
}

// --- The store boundary -----------------------------------------------------

// Never throws. A user who cannot read their saved cars still gets a working
// app on the prefs path, which is exactly why the prefs path was left intact.
//
// `readOnly` is the degraded mode: the stored payload came from a build that
// knows a shape this one does not, so what could be read has been read and
// nothing may be written back over it.
export function loadMyCars() {
  try {
    const raw = localStorage.getItem(CARS_KEY);
    if (!raw) return { ...emptyCarsState(), readOnly: false };
    const parsed = JSON.parse(raw);
    return { ...sanitizeCarsPayload(parsed), readOnly: payloadVersion(parsed) > CARS_V };
  } catch {
    return { ...emptyCarsState(), readOnly: false };
  }
}

export function emptyCarsState() {
  return { v: CARS_V, cars: [], activeId: null };
}

// One setItem, or none. Returns whether the write happened, so a caller can
// tell a refusal from a success instead of assuming.
//
// The version is re-read from storage on every write rather than trusted from
// whatever loadMyCars returned earlier, because another tab running a newer
// build can have written in between. A flag captured at load time would be
// stale in exactly the case it exists to catch.
export function saveMyCars(state) {
  try {
    const existing = localStorage.getItem(CARS_KEY);
    if (existing && payloadVersion(JSON.parse(existing)) > CARS_V) return false;
  } catch {
    // Unparseable or unreadable: there is no newer payload to protect, so the
    // write proceeds and replaces the junk.
  }
  try {
    const clean = sanitizeCarsPayload(state);
    localStorage.setItem(CARS_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false; // storage unavailable (private mode); app still works
  }
}

export function clearMyCars() {
  try {
    localStorage.removeItem(CARS_KEY);
  } catch {
    /* ignore */
  }
}

// --- List operations --------------------------------------------------------
//
// Pure: each one takes a state and returns a new state, never mutating what it
// was given, so the rules are testable without a store. Writing is the caller's
// separate step.

// A fresh id that nothing in `taken` is using.
//
// NOT crypto.randomUUID(): that is undefined outside a secure context, so it
// throws on plain http, which is how this app gets tested on a phone over a
// LAN. A store helper that only works on https is a store helper that fails
// exactly where a charging app is used.
//
// The timestamp prefix makes ids at least nine characters, so a minted id can
// never collide with a migrated c1 through c5. The collision loop is what makes
// that a guarantee rather than an argument.
export function newMyCarId(taken) {
  const used = new Set(taken || []);
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 46656).toString(36).padStart(3, "0");
  let id = `c${stamp}${rand}`;
  for (let n = 1; used.has(id); n++) id = `c${stamp}${rand}${n.toString(36)}`;
  return id;
}

// Add a car, or say why not. The id is always minted here and never accepted
// from the caller: it is opaque, so no caller has a reason to choose one, and
// minting against the ids in hand is what makes uniqueness structural instead
// of a check that has to be remembered.
//
// `getCar` is the live dataset, handed in rather than imported so this stays
// testable with a stub, and it is the ONLY source of the car's onboard
// maximum. maxKw is written after the caller's draft is spread, so a draft
// that carries one of its own loses it. That matters because the caller
// assembles the draft from the edit fields, which is the path an outlet
// reading would have to take to get in here.
//
// AT THE CAP IT REFUSES AND REPORTS. It does not evict the oldest car, and it
// does not accept the car and quietly keep five. Both of those lose something
// the user chose without telling them, and this store exists so a user stops
// losing numbers they entered. The caller gets `reason` and `limit` so it can
// say what happened in the user's own terms.
export function addMyCar(state, car, getCar) {
  const cars = Array.isArray(state?.cars) ? state.cars : [];
  if (cars.length >= MAX_MY_CARS) return { ok: false, reason: "full", limit: MAX_MY_CARS, state: asState(state) };

  const entry = safeCar({
    ...car,
    id: newMyCarId(cars.map((c) => c.id)),
    maxKw: datasetChargeKw(getCar, safeCarId(car?.carId)),
  });
  if (!entry) return { ok: false, reason: "invalid", state: asState(state) };

  // The first car saved becomes the selected one, because a list with cars in
  // it and nothing selected is the "no car chosen" state and the user just
  // chose one. Adding a second car does NOT steal the selection: switching is
  // an explicit act, and decision 6 already settled that a mis-tap must not
  // move the user somewhere they did not ask to go.
  const activeId = state?.activeId ?? entry.id;
  return { ok: true, reason: "ok", state: { v: CARS_V, cars: [...cars, entry], activeId } };
}

// Remove a car. Deleting the selected one leaves a dangling id, which is the
// same situation the loader already has a rule for, so it is handed to that
// rule rather than given a second one. The app is never left holding an id
// that resolves to nothing.
export function removeMyCar(state, id) {
  const cars = Array.isArray(state?.cars) ? state.cars : [];
  const next = cars.filter((c) => c.id !== id);
  if (next.length === cars.length) return { ok: false, reason: "not-found", state: asState(state) };
  return { ok: true, reason: "ok", state: { v: CARS_V, cars: next, activeId: resolveActiveId(next, state?.activeId ?? null) } };
}

// Select a car. Passing null deselects, which is a real state: it is what the
// app shows today before any car is picked.
export function setActiveMyCar(state, id) {
  const cars = Array.isArray(state?.cars) ? state.cars : [];
  if (id !== null && !cars.some((c) => c.id === id)) return { ok: false, reason: "not-found", state: asState(state) };
  return { ok: true, reason: "ok", state: { v: CARS_V, cars, activeId: id } };
}

// The selected record, or null. A null activeId is a real state and not a
// missing one (see resolveActiveId), so it is answered rather than repaired.
export function activeMyCar(state) {
  const cars = Array.isArray(state?.cars) ? state.cars : [];
  const id = state?.activeId ?? null;
  if (id === null) return null;
  return cars.find((c) => c.id === id) ?? null;
}

// The saved record pointing at a given dataset car, or null.
//
// This lookup is what makes decision 6 true. The typeahead REPLACES the
// selection rather than growing the list, so picking a car the user already
// saved has to find that record instead of minting a second one. Without it
// five mis-taps are five cars and the cap refuses the sixth real one.
//
// Two records may legitimately share a carId, which is the entire point of the
// feature, and this answers the FIRST of them. Deterministic rather than
// correct: a carId cannot say which of two saved Volts the user meant, and list
// order is the order they see. The explicit picker settles it later.
export function findMyCarByCarId(state, carId) {
  if (!carId) return null;
  const cars = Array.isArray(state?.cars) ? state.cars : [];
  return cars.find((c) => c.carId === carId) ?? null;
}

// Fold freshly typed numbers into one saved car, to the SAME OUTCOME
// mergeCarOverride produces for the legacy override: positiveNumber on the way
// in, and a value that fails it keeps the last good one rather than erasing
// something the user already saved. main.js writes both stores from a single
// call site, so a rule that disagreed here would diverge them on the first
// field cleared mid-edit, which is a keystroke away at all times.
//
// The MECHANISM is not the same one, and saying so is the point of this
// paragraph. mergeCarOverride builds its result from an empty object, so it has
// to name the fallback: `positiveNumber(next[k]) ?? positiveNumber(base[k])`.
// Here the spread has already copied the saved value, so a rejected input
// simply never overwrites it. Writing the `??` form here too would read as the
// thing doing the work while changing nothing, and a guard that cannot fail is
// worse than no guard: it is a claim with nothing behind it.
//
// Only CAR_NUMBER_KEYS are read out of `inputs`, and the caller hands this the
// whole live input model. That narrowing is what keeps the OUTLET out of a
// car's record, the same way applyCarEdit's does. maxKw rides across on the
// spread untouched, because it is not one of those keys and the loop is the
// only thing that writes.
export function applyMyCarEdit(state, id, inputs) {
  const cars = Array.isArray(state?.cars) ? state.cars : [];
  const target = cars.find((c) => c.id === id);
  if (!target) return { ok: false, reason: "not-found", state: asState(state) };

  const src = inputs && typeof inputs === "object" ? inputs : {};
  const next = { ...target };
  for (const k of CAR_NUMBER_KEYS) {
    const v = positiveNumber(src[k]);
    if (v !== undefined) next[k] = v;
  }
  return {
    ok: true,
    reason: "ok",
    state: { v: CARS_V, cars: cars.map((c) => (c === target ? next : c)), activeId: state?.activeId ?? null },
  };
}

function asState(state) {
  return state && typeof state === "object" ? state : emptyCarsState();
}

//
// PURE, and that is not a style preference. The migration is the one step that
// can silently cost a user numbers they typed months ago, so it has to be
// runnable in a test with no DOM and no store, against a legacy prefs object
// written out by hand.
//
// The dataset lookup arrives as an argument for the same reason. Labels are
// snapshotted at migration time so a later reseed that renames or drops a
// carId degrades the LABEL and never the numbers, and an orphaned car keeps
// working. The onboard maximum is snapshotted for the same reason and is the
// stronger case: a stale label is cosmetic, a lost ceiling makes the estimate
// optimistic. Capturing either requires the live dataset, and taking it as
// functions keeps this testable with a stub.

// The one definition of the custom-car sentinel. main.js held its own copy of
// the literal until 64994ed deleted it; it imports this now, so there is one
// spelling of the identity rather than two with nothing keeping them equal. A
// source guard in test/myCars.test.mjs pins that a second copy does not return.
export const CUSTOM_CAR_ID = "__custom__";

// A car's label is cosmetic; its numbers are not. A lookup that throws must
// cost the label rather than the whole migration.
function labelOf(labelFor, carId) {
  if (typeof labelFor !== "function") return "";
  try {
    const s = labelFor(carId);
    return typeof s === "string" ? s : "";
  } catch {
    return "";
  }
}

// Build the saved-cars payload from a legacy prefs object. Returns the payload
// and the carIds that did not fit, never a partial write and never a throw of
// its own.
//
// ORDERING, and it is deterministic by construction rather than by luck. The
// active car is first, because it is the one on screen and the one the user
// recognises. Everything else follows in ascending carId order, using the
// default code-unit sort so the answer does not depend on a locale or on the
// insertion order of a parsed object.
//
// The ACTIVE car's numbers come from the live top-level values, falling back to
// its override. That is the ordering that makes "the app renders identically
// after migration" true: the top-level values are literally what is in the
// fields right now, and applyCarSelection already promoted the override into
// them when the car was picked. Every other car has only its override.
export function migrateCars(prefs, labelFor, getCar) {
  const p = prefs && typeof prefs === "object" ? prefs : {};
  const overrides = p.carOverrides && typeof p.carOverrides === "object" ? p.carOverrides : {};
  const activeCarId = typeof p.carId === "string" && p.carId ? p.carId : null;

  // JSON.parse creates a real own "__proto__" property, so Object.keys does
  // list it. Same guard as safeOverrides, at the same boundary.
  const keys = Object.keys(overrides).filter((k) => !RESERVED_KEYS.has(k));
  const ordered = activeCarId
    ? [activeCarId, ...keys.filter((k) => k !== activeCarId).sort()]
    : keys.sort();

  // Over the cap, the extras are left behind rather than thrown away, and the
  // difference is real: sicc.prefs.v1 and carOverrides are untouched and still
  // written, so every dropped car's numbers are still on disk for the whole
  // rollback window. Nothing is lost, and the caller is told what did not fit
  // so it can say so rather than let the user discover it.
  const kept = ordered.slice(0, MAX_MY_CARS);
  const dropped = ordered.slice(MAX_MY_CARS);

  const drafts = kept.map((carId, i) => {
    const ov = overrides[carId] && typeof overrides[carId] === "object" ? overrides[carId] : {};
    const live = carId === activeCarId;
    const draft = {
      id: `c${i + 1}`,
      carId,
      label: labelOf(labelFor, carId),
      // customName has always described the custom car and nothing else. This
      // is the field it belonged in from the start.
      name: carId === CUSTOM_CAR_ID ? p.customName : "",
      // Taken from the dataset exactly like the label beside it. An entry whose
      // carId no longer resolves gets none, which is correct and unavoidable:
      // we never had one to carry across. The `ov` below holds a legacy
      // powerKw, which is an OUTLET reading, and the loop cannot reach this key
      // because maxKw is not one of CAR_NUMBER_KEYS.
      maxKw: datasetChargeKw(getCar, carId),
    };
    for (const k of CAR_NUMBER_KEYS) {
      const v = live ? (positiveNumber(p[k]) ?? positiveNumber(ov[k])) : positiveNumber(ov[k]);
      if (v !== undefined) draft[k] = v;
    }
    return draft;
  });

  // Routed through the sanitizer rather than returned raw, so the migration's
  // output is a fixed point of the read path BY CONSTRUCTION. Building the
  // payload directly would make idempotency a thing held by inspection, which
  // is what a test would then be pinning instead of enforcing.
  const activeId = activeCarId ? "c1" : null;
  return { payload: sanitizeCarsPayload({ v: CARS_V, cars: drafts, activeId }), dropped };
}

// The store-boundary wrapper: migrate once, atomically, or not at all.
//
// Fail-safe in the literal sense. Anything unexpected means no write, and the
// app carries on with the single-car behavior it has today, because
// sicc.prefs.v1 was deliberately left intact for exactly this. A user who
// cannot be migrated must still get a working app.
//
// Never runs twice. The presence of the key is the record that it already ran,
// which is also what keeps a user who deleted all their saved cars from having
// them resurrected on the next load.
export function migrateIfNeeded(prefs, labelFor, getCar) {
  try {
    if (localStorage.getItem(CARS_KEY) !== null) return { migrated: false, reason: "already-present", dropped: [] };

    const { payload, dropped } = migrateCars(prefs, labelFor, getCar);
    // Nothing to carry across is a normal outcome, not a failure: a user who
    // never picked a car and never edited a number gets zero cars, not a
    // phantom one. Writing an empty payload would also burn the one-shot flag.
    if (!payload.cars.length) return { migrated: false, reason: "nothing-to-migrate", dropped };

    // Build fully in memory, then exactly one setItem. saveMyCars is the only
    // writer, so there is no incremental path to interrupt.
    if (!saveMyCars(payload)) return { migrated: false, reason: "write-refused", dropped };
    return { migrated: true, reason: "ok", dropped, cars: payload.cars.length };
  } catch {
    return { migrated: false, reason: "failed", dropped: [] };
  }
}

