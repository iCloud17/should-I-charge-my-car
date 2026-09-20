// main.js - wire inputs → calc → render. Persist to localStorage.

import { breakevenKwhPrice, chargeCurve, verdict, rateAtTime, rateAtElapsed, cheapestPeriod } from "./calc.js";
import * as U from "./units.js";
import {
  loadPrefs, savePrefs, resetPrefs, defaultPrefs,
  applyCarEdit, applyCarSelection, persistableFrom, CAR_EDIT_FIELDS, MAX_CUSTOM_NAME_LEN,
} from "./storage.js";
import {
  loadCars, getCar, getCars, carLabel, maxLabelLength,
  chargeDrawKw, presetMatchesKw,
} from "./cars.js";
import { CUSTOM_CAR_ID, MAX_MY_CARS, CARS_KEY, loadMyCars, saveMyCars, clearMyCars, emptyCarsState, migrateIfNeeded,
  addMyCar, removeMyCar, setActiveMyCar, applyMyCarEdit, renameMyCar, refreshMyCars,
  activeMyCar, findMyCarByCarId, savedCarNumbers, savedCarDraft, savedCarCeilingKw,
} from "./myCars.js";
import {
  showsAddControl, addControlLabel, showsChipRow, showsRemoveLink, showsCarListActions,
  showsNameField, buildChips, chipBaseLabel, chipLabelFor, checkedChipId,
  copyBaseName, takenCarNames, nextCopyName, pickerOpenQuery,
  nextChipIndex, addRefusalMessage, addWriteFailedMessage, addedMessage, carSummaryLabel, carTileSource,
  newCarName, defaultCarName, withDefaultNames,
  legacyNameSlot, nameFieldValue, removedMessage, removeWriteFailedMessage, removeConfirmQuestion,
  removeGoneMessage, nameWriteFailedMessage, numbersWriteFailedMessage, selectionWriteFailedMessage,
} from "./myCarsUi.js";
import { $, parseNum, money, formatDuration, escapeHtml, nextOptionIndex, enterAction } from "./ui.js";
import { applyTheme, nextThemeMode, themeLabel } from "./theme.js";
import { track, trackWhenReady } from "./analytics.js";
import {
  addTouRow, addDurRow, addTimeFeeRow, addTaxRow,
  readSchedule, readDurationTiers, readTimeFee, readTaxRate,
} from "./editorRows.js";
import { createDropdown } from "./dropdown.js";

let prefs = loadPrefs();
let myCars = emptyCarsState(); // sicc.cars.v1, filled in by initMyCars() at boot
// Did initMyCars() get all the way through? Every write to the store is gated
// on it, and that gate is load bearing rather than defensive.
//
// initMyCars bails when the dataset fetch failed, because the one-shot
// migration would otherwise write cars with no label and no onboard maximum.
// If a car selection could still write after that bail, the SELECTION would
// create sicc.cars.v1, and the key's presence is the record that the migration
// already ran. The user's carOverrides would then never be carried across, on
// this load or any later one. A store that was never written falls back to
// prefs and loses nothing; a half-written one loses the migration.
let myCarsLive = false;
let rateMode = "flat"; // "flat" | "tod" | "dur" (volatile - never persisted)
let chargeCapMin = null; // "charge for" slider value in minutes (volatile)
let capTouched = false;  // has the user dragged the "charge for" slider?
let currencyDropdown = null, unitDropdown = null; // built in attachEvents()

// Above this, a stop-early recommendation reads as "partway", not "briefly".
const BRIEF_MAX_MIN = 60;

// --- Read canonical model values from the DOM (converting from display units) ---
function readInputs() {
  const system = prefs.units;
  const read = (id, toCanonical) =>
    U.canonicalFromField($(id).value, painted.get(id), (text) => toCanonical(parseNum(text)));
  const asTyped = (v) => v;

  return {
    gasPrice: read("gasPrice", (v) => U.gasPriceToCanonical(v, system)),
    yourRate: read("yourRate", asTyped), // $/kWh is universal
    mpg: read("mpg", (v) => U.economyToCanonical(v, system)),
    miPerKwh: read("miPerKwh", (v) => U.efficiencyToCanonical(v, system)),
    batteryKwh: read("batteryKwh", asTyped),
    sessionFee: read("sessionFee", asTyped) || 0,
    powerKw: read("powerKw", asTyped),
    startPct: parseNum($("startPct").value),
    targetPct: parseNum($("targetPct").value),
  };
}

// Persist a render pass. `m` must carry the RAW outlet power: persistableFrom
// stores powerKw as typed, and the car's cap belongs downstream at drawKw.
function persistFrom(m) {
  prefs = persistableFrom(prefs, m);
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
  const taxRate = readTaxRate();
  const hasTax = taxRate > 0;
  let rateOf = null, schedule = null, hasRate = false, startClockMin = 0, durTiers = null;
  if (rateMode === "tod") {
    schedule = readSchedule();
    if (schedule.length) { rateOf = (clock) => rateAtTime(schedule, clock); hasRate = true; startClockMin = nowMinutes(); }
  } else if (rateMode === "dur") {
    durTiers = readDurationTiers();
    if (durTiers.length) { rateOf = (_clock, elapsed) => rateAtElapsed(durTiers, elapsed); hasRate = true; }
  }
  if (!rateOf) {
    // Only the flat mode uses the single charger-price field. In time-of-day or
    // by-duration mode with no schedule entered yet there's no price to judge,
    // so leave hasRate false and show the break-even prompt instead of silently
    // reusing the (now disabled) flat field.
    if (rateMode === "flat") hasRate = Number.isFinite(m.yourRate) && m.yourRate >= 0;
    rateOf = () => (hasRate ? m.yourRate : 0);
  }

  // The outlet can be set higher than the car's onboard charger accepts, so cap
  // it here, at the point of use. Clamping the stored value instead would only
  // ever ratchet it down and lose what the user typed, so m.powerKw stays raw
  // all the way to persistFrom below.
  const drawKw = chargeDrawKw(m.powerKw, ceilingCar());

  const curveArgs = { batteryKwh: m.batteryKwh, startPct: m.startPct, targetPct: m.targetPct, powerKw: drawKw, rateOf, sessionFee: m.sessionFee, timeTiers, taxRate, breakeven: be, startClockMin };

  // Full charge first: its duration is the far end of the "charge for" slider.
  const full = chargeCurve({ ...curveArgs, capMinutes: Infinity });
  const fullChargeMin = full.fullMinutes;

  // Stopping early can change the outcome only when the price gets worse the
  // longer you charge: a by-the-hour time fee, or rising by-duration tiers. In
  // those modes the "Charge for" slider prices a partial charge; otherwise the
  // effective price is flat and stopping early changes nothing.
  const canStopEarly = hasTimeTiers || rateMode === "dur";

  // The longest you can charge while still beating gas, and whether even a short
  // charge loses - both only meaningful when charging longer can worsen the price.
  const worthLimitMin = canStopEarly && full.everWorth ? full.worthLimitMin : null;
  const fullNotWorth = canStopEarly && !full.everWorth;

  // Best-value stop: the partial charge that saves the most vs gas. For rising
  // by-duration tiers, stop where the rate crosses gas; for a per-hour time fee,
  // chargeCurve's most-savings point. Only surface it when it's a confident win
  // and meaningfully better than topping off (>= 3 points more savings).
  const vFull = verdict(full.effectivePerKwh, be);
  let tip = (rateMode === "dur" && worthLimitMin != null && worthLimitMin < fullChargeMin - 0.5)
    ? durSweetSpot(durTiers, be, curveArgs, m, cur)
    : null;
  if (!tip && hasTimeTiers) {
    const s = timeFeeSweetSpot(full, curveArgs, m, cur, be);
    if (s && s.worth && s.improvesBy >= 3) tip = s;
  }
  // Steer to the partial charge ("charge briefly/partway") when topping off to
  // the target isn't itself a confident win but the best-value stop is.
  const showBriefly = !!(tip && vFull !== "worth");

  // Display selection: the slider if the user set it, else the recommended
  // partial charge when we're steering them to stop early, else the full charge.
  let cap = Infinity;
  if (canStopEarly && capTouched && Number.isFinite(chargeCapMin) && chargeCapMin < fullChargeMin - 0.5) cap = chargeCapMin;
  else if (showBriefly && !capTouched) cap = tip.min;
  const session = cap === Infinity ? full : chargeCurve({ ...curveArgs, capMinutes: cap });

  updateChargeSlider(canStopEarly && fullChargeMin > 0, fullChargeMin, session.minutes, session.soc, hasTimeTiers);

  const kwh = session.kwhFromCharger;
  const timeFee = session.timeFee;
  const hasTimeFee = timeFee > 0;
  const hasFees = m.sessionFee > 0 || hasTimeFee || hasTax;

  let effective = NaN;
  if (hasRate) {
    // With a real charge we use the all-in average (energy + fees + tax). Before
    // a battery size is known there's no kWh to amortize per-session/per-hour
    // fees over, so we fall back to the entered rate - but tax is a plain
    // per-kWh multiplier that applies regardless, so keep it in the fallback.
    effective = kwh > 0 ? session.effectivePerKwh : m.yourRate * (1 + taxRate);
  }
  const showEffective = rateMode !== "flat" || hasFees;

  // --- Analytics: categorical funnel + feature usage (each once per session) ---
  if (Number.isFinite(m.mpg) && Number.isFinite(m.miPerKwh)) {
    track("car-selected");
    track(prefs.carId && prefs.carId !== CUSTOM_CAR_ID ? "car-from-list" : "car-custom");
  }
  if (hasRate) {
    track("charger-priced");
    track(rateMode === "tod" ? "mode-time-of-day" : rateMode === "dur" ? "mode-by-duration" : "mode-flat");
  }
  if (m.sessionFee > 0) track("fees-session");
  if (hasTimeTiers) track("fees-time");
  if (hasTax) track("fees-tax");

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
    sub.textContent = rateMode === "tod"
      ? "Break-even price. Add your time-of-day rates below for a yes/no."
      : rateMode === "dur"
        ? "Break-even price. Add your duration tiers below for a yes/no."
        : "Break-even price. Enter the charger's energy rate for a yes/no.";
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

    track("verdict-shown");
    track(showBriefly ? "verdict-charge-briefly" : v === "worth" ? "verdict-charge-it" : v === "gas" ? "verdict-use-gas" : "verdict-toss-up");

    card.dataset.verdict = showBriefly ? "close" : (v === "unknown" ? "close" : v);
    // "Briefly" for a genuinely short stop, "partway" once it runs long.
    headline.textContent = showBriefly
      ? (tip.min <= BRIEF_MAX_MIN ? "\u26A1 Charge briefly" : "\u26A1 Charge partway")
      : v === "worth" ? "\u26A1 Charge it" : v === "gas" ? "\u26FD Use gas" : "\u2248 Toss-up";

    // Layman framing: the gas price that would cost the same per mile, plus how
    // much cheaper/pricier charging is per mile. Everyone intuits gas prices.
    const gasPerMile = m.gasPrice / m.mpg;
    const elecPerMile = effective / m.miPerKwh;
    const equivGas = (effective * m.mpg) / m.miPerKwh; // canonical $/gallon
    const equivDisp = U.gasPriceForDisplay(equivGas, prefs.units);
    const gasUnit = prefs.units === "imperial" ? "/gal" : "/L";
    const pct = gasPerMile > 0 ? Math.round((Math.abs(gasPerMile - elecPerMile) / gasPerMile) * 100) : 0;
    // "Pricier" as a percentage reads as confusing once it hits 100% (2x),
    // so at/above 100% we switch to a rounded multiplier ("~2x", "~2.5x",
    // "~3x") in 0.5 steps; under 100% the percentage is clear, so keep it.
    // Gate on the rounded pct (not mult >= 2) so floating-point values a hair
    // under 2x (e.g. 1.9999) still show "~2x" instead of "100% pricier".
    const mult = gasPerMile > 0 ? elecPerMile / gasPerMile : NaN;
    const pricier = pct >= 100
      ? `~${Math.round(mult * 2) / 2}x the price`
      : `${pct}% pricier`;
    // The sub always describes the CURRENT selection (updates live with the
    // slider), so it never disagrees with the price shown for it just below.
    sub.textContent = !(m.gasPrice > 0)
      ? "Gas is free here, so charging can't win."
      : v === "worth"
      ? `Like ${money(equivDisp, cur)}${gasUnit} gas, ${pct}% cheaper`
      : v === "gas"
        ? (mult > 100
            ? "Charging here costs far more than gas."
            : `Like ${money(equivDisp, cur)}${gasUnit} gas, ${pricier}`)
        : pct > 0
          ? `About the same as gas (~${money(equivDisp, cur)}${gasUnit}), leaning ${elecPerMile < gasPerMile ? "cheaper" : "pricier"} ${pct}%`
          : `About the same as gas (~${money(equivDisp, cur)}${gasUnit})`;

    detailLine.hidden = false;
    detailLine.textContent = showEffective
      ? `Effective ${money(effective, cur)}/kWh${hasFees ? " incl. fees" : ""} \u00b7 break-even ${money(be, cur)}/kWh`
      : `You pay ${money(m.yourRate, cur)}/kWh \u00b7 break-even ${money(be, cur)}/kWh`;

    // "How long" at a glance, using your saved battery / power / charge target.
    if (!showBriefly && v !== "gas" && Number.isFinite(session.minutes) && session.minutes > 0) {
      timeline.hidden = false;
      timeline.textContent = `Est. ${formatDuration(session.minutes)} to ${Math.round(session.soc)}% at ${round(drawKw, 2)} kW`;
    } else {
      timeline.hidden = true;
    }

    // Time-of-day suggestion based on the current clock time. Suppressed when a
    // best-value tip is showing, so the card gives one clear action, not two.
    if (rateMode === "tod" && schedule && schedule.length && !tip) {
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
    // tiers, or a per-hour time fee whose $/kWh bottoms out below 100%), surface
    // the sweet spot in a distinct green block (miles + saving). Otherwise fall
    // back to the plain worth-limit note or hide it. The "Charge for" slider
    // answers "how far can I go."
    worthTip.hidden = true;
    if (tip) {
      timeNote.hidden = true;
      worthTip.hidden = false;
      $("worthTipLead").textContent = `\uD83D\uDCA1 Best value: charge about ${formatDuration(tip.min)}`;
      $("worthTipSub").textContent = `~${tip.range} ${tip.rangeUnit} \u00b7 like ${tip.equiv}${tip.unit} gas, ${tip.pct}% cheaper`;
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

  renderAdvanced(m, be, cur, session, effective, timeFee, drawKw);
  updatePresetActive();
  persistFrom(m);
}

// The dataset entry for the selected car, or null for a custom car (or none
// picked yet). The only thing that turns prefs into a car, so every charge-power
// cap routes through cars.js and this file never invents its own ceiling.
//
// That is not the same as the cap being pinned here. chargeDrawKw is already
// imported above, so moving the cap up into readInputs is a one-line edit that
// leaves the suite green while ratcheting the capped value into m.powerKw and
// on into storage. The rule is that a capped value never reaches m.powerKw;
// review enforces that, the tests do not.
function currentCar() {
  return prefs.carId && prefs.carId !== CUSTOM_CAR_ID ? getCar(prefs.carId) : null;
}

// --- Saved cars -------------------------------------------------------------
//
// sicc.cars.v1 is the READ source for a car's numbers. sicc.prefs.v1 and
// carOverrides keep being written exactly as they are today, for one release,
// as the rollback: either store alone can drive the app.
//
// This file is the one place allowed to import both. myCars.js never touches
// sicc.prefs.v1, which is what stops a cached old build from deleting saved
// cars through savePrefs.
//
// Each store is internally consistent, so divergence would be silent. Three
// structural rules keep them level: saveCarNumbers is the ONE WRITER of either
// store's car numbers, from the same readInputs() object in the same call;
// selectMyCar runs on the same event as applyCarSelection, so there is ONE
// SELECTOR; and a MISMATCH READS AS ABSENT, because the five-car cap can refuse
// a car prefs has already accepted, and an active record answering for the
// wrong vehicle would cap the estimate against the wrong onboard charger.

// A dataset label for a carId, for the migration's snapshot. Empty when the
// dataset cannot answer, which migrateCars reads as a missing label and never
// as a missing car.
function labelForCarId(carId) {
  const car = getCar(carId);
  return car ? carLabel(car) : "";
}

// A saved-cars state with a name on every car. The fill is part of READING the
// payload, so it costs no write: the names reach disk with the next real one,
// and a load that wrote would set two tabs answering each other forever.
function namedState(state) {
  return { ...state, cars: withDefaultNames(state.cars, getCar) };
}

// Bring the store up, once, at boot. Silent either way: this is plumbing, and
// a user who has never heard of saved cars has nothing to be told.
function initMyCars() {
  try {
    // Not while the dataset is missing. loadCars() answers with an empty list
    // on a failed fetch, and the migration is one-shot, so running it then
    // would burn that single chance and write every car with no label and no
    // onboard maximum. Skipping leaves the key absent and the next load with a
    // working fetch migrates properly.
    if (!getCars().length) return;
    // Counted, not spoken: boot()'s repaint below clears this note before anyone
    // could read it, and the event is the only sign the numbers are stranded.
    if (migrateIfNeeded(prefs, labelForCarId, getCar).reason === "write-refused") countWriteRefused();
    myCars = namedState(loadMyCars());
    myCarsLive = true;
  } catch {
    // Both calls above are already total, so this is the outer boundary rather
    // than the guard. It is here because initMyCars runs inside init(), ahead
    // of attachEvents and boot: anything that escaped would cost the user the
    // whole app rather than their saved cars. myCars stays empty and every read
    // below falls through to the prefs path that shipped before this feature.
    myCars = emptyCarsState();
    myCarsLive = false;
  }
}

// The saved record for the car on screen, and only when both stores agree that
// it IS the car on screen. See the mismatch rule above.
function activeSavedCar() {
  if (!prefs.carId) return null;
  const saved = activeMyCar(myCars);
  return saved && saved.carId === prefs.carId ? saved : null;
}

// Point the store at the record for `carId`, or at nothing when no record holds
// that car. It NEVER creates one: addCurrentCar is the only thing that grows
// the list, because a picker that saves whatever you looked at fills a five-car
// cap with cars nobody chose and then refuses the one that was wanted.
//
// THE DESELECT IS THE WHOLE NO-RECORD BRANCH, and returning early instead is
// the defect it replaces. The previous car's record stayed active while the
// screen moved on, so its chip stayed lit beside another car's numbers and the
// estimate capped against another car's onboard charger. Nothing selected is a
// state this store can hold, so it is held rather than left stale.
function selectMyCar(carId) {
  if (!myCarsLive) return { saved: null, wrote: NO_REFUSAL };
  // The record is re-found rather than carried in, because two records may
  // share a carId and the store's own rule is that the first of them answers.
  const found = findMyCarByCarId(myCars, carId);
  myCars = setActiveMyCar(myCars, found?.id ?? null).state;
  // A REFUSED SELECTION IS SPOKEN, NOT OBEYED, which is where this parts
  // company with the four content writes. They drop their new state, because an
  // add can simply not add; a selection cannot un-show the car the user is
  // looking at, and leaving the store on the previous car is the checked-chip
  // mismatch the deselect branch above exists to prevent. What it used to do
  // instead was neither: the answer was discarded, savePrefs moved carId on its
  // own, and the next reload read a saved car as unsaved and offered to add it
  // again. The refusal is handed BACK because the caller's repaint clears the
  // note, so the caller is the only thing that can say it in an order that
  // survives.
  const wrote = saveMyCars(myCars);
  return { saved: activeMyCar(myCars), wrote };
}

// Put the car on screen into the list, and say what happened either way. THE
// ONLY CALLER OF addMyCar in the app: picking shows a car and this saves one,
// and keeping those two apart is the whole of the redesign.
//
// Gated on myCarsLive like every other write, because the key's own presence is
// what records that the one-shot migration already ran.
//
// EVERY REFUSAL IS SPOKEN, including the ones the old implicit add dropped. The
// store says no for a reason it names, and a refusal flattened to nothing is
// how a user came to be shown a car that had never been saved. A refused WRITE
// is the same shape one layer down: saveMyCars answers false when storage is
// unavailable or a newer build's payload is on disk, and painting a fresh chip
// over that would tell the user their car is in a list it never reached.
function addCurrentCar() {
  if (!myCarsLive) return;

  const car = currentCar();
  const saved = activeSavedCar();
  // Already saved means this is a COPY, and a copy is given a name of its own
  // rather than left to the chip suffix: that suffix is computed from position,
  // so removing a car in the middle renumbers every car after it.
  const copied = saved
    ? nextCopyName(copyBaseName(saved, getCar), takenCarNames(myCars.cars, getCar), MAX_CUSTOM_NAME_LEN)
    : "";
  const label = car ? carLabel(car) : saved?.label ?? "";
  const name = newCarName(
    copied,
    legacyNameSlot(prefs.carId === CUSTOM_CAR_ID, prefs.customName),
    defaultCarName({ carId: prefs.carId, label }, getCar),
  );
  const draft = prefs.carId === CUSTOM_CAR_ID ? { name } : { name, label };

  // The numbers the user is looking at travel with the car. The record used to
  // be minted at pick time, ahead of every edit, with saveCarNumbers keeping it
  // in step from there; it is minted AFTER those edits now, so an empty draft
  // would hand this car the dataset's numbers back the next time it is switched
  // to.
  //
  // THE ACTIVE RECORD IS WHAT IS ON SCREEN, and prefs.carOverrides is not. That
  // store has one slot per MODEL, so with two records of one model it holds
  // whichever of them was edited last: copying the Prius whose chip is checked
  // minted a record carrying the OTHER Prius's numbers, under this one's
  // heading, invisibly until the user switched chips and came back.
  //
  // The override stays the fallback for a car with NO record, where it is
  // unambiguous by construction: a saved car is always switched to rather than
  // shown unsaved, so an unsaved car on screen is the only car of its model
  // this user has.
  const seed = saved ? savedCarDraft(saved) : prefs.carOverrides?.[prefs.carId];
  const res = addMyCar(myCars, { ...seed, ...draft, carId: prefs.carId }, getCar);
  if (!res.ok) {
    sayMyCarsNote(addRefusalMessage(res.reason, MAX_MY_CARS));
    return;
  }

  // addMyCar appends, so the new record is the last one. Named by position
  // rather than looked up, because findMyCarByCarId answers the FIRST record
  // carrying this carId, which under "Add a copy" is the car being copied.
  const added = res.state.cars[res.state.cars.length - 1];
  const next = setActiveMyCar(res.state, added.id).state;
  const wrote = saveMyCars(next);
  if (!wrote.ok) {
    // `next` is dropped rather than kept: myCars is left as it was, so the
    // screen and the disk still agree, and the message is true when it says
    // nothing was added.
    sayWriteRefused(addWriteFailedMessage(wrote.reason));
    return;
  }
  myCars = next;

  // Counted AFTER the write, so a refused add is not reported as one. These are
  // one-shot acts rather than part of the recalc path, so they use
  // trackWhenReady: a track() that arrives before GoatCounter has loaded is
  // dropped, and nothing here runs again to retry it.
  trackWhenReady("cars-added");
  // The 1 to 2 transition, which is the question this answers: does anyone go
  // past one car at all. `=== 2` and not `>= 2`, or every later add re-reports
  // a step that happens once.
  if (next.cars.length === 2) trackWhenReady("cars-second-added");
  if (copied) trackWhenReady("cars-copy-added");

  // The legacy name slot follows the active record, which is the rule
  // switchToMyCar holds: customName is the last value carSummaryLabel and
  // carNameForField consult, so leaving it on the car this one was copied from
  // names the copy after it, on this paint and on every reload after it.
  if (prefs.carId === CUSTOM_CAR_ID) {
    prefs.customName = added.name;
    savePrefs(prefs);
  }

  // The same repaint a switch does, because that is what this is: the active
  // record has changed.
  $("carName").textContent = carSummaryText(added, car);
  writeDisplayValues();
  renderMyCars();
  render(); // a copy of an orphaned car carries no ceiling snapshot, so the estimate can move
  // After the repaint, which clears the note. Same order removeActiveCar uses,
  // and for the same reason: this live region is the whole of what a screen
  // reader gets for either act.
  sayMyCarsNote(addedMessage(chipBaseLabel(added, getCar)));

  // A copy arrives carrying a name the app chose, so hand the user the field
  // it is in: the panel is shut by default, and a suggestion nobody sees is a
  // suggestion nobody edits. SELECTED, not appended to, so one keystroke
  // replaces the whole thing rather than landing on the end of it.
  if (copied) {
    $("tweak").open = true;
    $("carNickname").focus();
    $("carNickname").select();
  }
}

// What these two answer when nothing refused them, including when there was
// nothing to refuse: a caller reads `.ok` to decide whether to speak, and a
// write that never happened is not something to complain to the user about.
const NO_REFUSAL = { ok: true, reason: "ok" };

// The one writer of a car's numbers. Both stores are written here, from the
// same inputs, in the same call. Keeping them in step is therefore not
// something a later caller has to remember: there is nowhere else to write
// from, and a test pins that there is exactly one call to each.
//
// carOverrides goes first and unconditionally. It is the rollback, so it is
// written exactly as it is today whether or not the cars layer can answer.
//
// Answers `{ ok, reason }` the way saveMyCars does, because the write can be
// refused and the caller is the only thing that can say so.
function saveCarNumbers(inputs) {
  prefs = applyCarEdit(prefs, prefs.carId, inputs);
  savePrefs(prefs);

  const saved = activeSavedCar();
  if (!saved) return NO_REFUSAL;
  const res = applyMyCarEdit(myCars, saved.id, inputs);
  if (!res.ok) return NO_REFUSAL;
  // THE WRITE DECIDES, the shape addCurrentCar and removeActiveCar already use.
  const wrote = saveMyCars(res.state);
  if (wrote.ok) myCars = res.state;
  return wrote;
}

// The one writer of a car's NAME, the same shape saveCarNumbers uses for a
// car's numbers: both stores written from one value in one call, so keeping
// them in step is structural rather than remembered.
//
// THE SAVED RECORD IS THE SOURCE OF TRUTH. It is the only store that can hold
// a name PER CAR; prefs.customName is one slot, so at two cars it can only
// ever answer for one of them. That is why it is written second here and from
// the record's own value rather than from the text: it is the rollback mirror,
// the same role carOverrides plays for the numbers, and a mirror that
// re-derives its value is a second source waiting to disagree.
//
// customName is written ONLY for the custom car, because that is the only car
// it has ever described (migrateCars carries it into that car's name and no
// other). A name typed on a Volt at two cars must not land in the slot that
// answers for "My own car".
//
// With no saved record - a dead store, or the mismatch guard refusing to
// answer - the text goes straight to customName and savePrefs narrows it,
// which is exactly the single-car path that shipped before this feature.
//
// A REFUSED WRITE RETURNS WITHOUT MIRRORING. customName is the record's
// rollback copy, so writing it over a record the disk would not take is the
// divergence the mismatch rule exists to prevent.
function saveCarName(text) {
  const saved = activeSavedCar();
  let name = text;
  if (saved) {
    const res = renameMyCar(myCars, saved.id, text);
    if (res.ok) {
      // THE WRITE DECIDES. The rename used to show on the chip and the heading
      // over a disk that still held the old name, and was gone on reload.
      const wrote = saveMyCars(res.state);
      if (!wrote.ok) return wrote;
      myCars = res.state;
      name = activeMyCar(myCars)?.name ?? "";
    }
  }
  if (prefs.carId === CUSTOM_CAR_ID) prefs.customName = name;
  savePrefs(prefs);
  return NO_REFUSAL;
}

// --- The saved-cars UI ------------------------------------------------------
//
// ONE PAINTER and ONE SWITCHER. Everything this feature shows is rebuilt by
// renderMyCars - the note, the add link, the remove link, the name field and
// the chip row - so a later call site cannot repaint four of the five and leave
// the fifth stale. Every switch goes through switchToMyCar, so the
// charger-inputs rule stated there has exactly one place to hold.

// The status line under the picker. One writer, so "pick the car to add" and a
// cap refusal cannot both be on screen at once saying different things.
function sayMyCarsNote(text) {
  $("myCarsNote").textContent = text;
}

function clearMyCarsNote() {
  sayMyCarsNote("");
}

// The four refusals a WRITE can produce, counted on their way to the screen. A
// user who quietly loses a saved car is invisible from outside the browser, and
// storage being unavailable or holding a newer build's payload is exactly the
// kind of failure nobody reports: this event is the only signal it happened.
function sayWriteRefused(text) {
  countWriteRefused();
  sayMyCarsNote(text);
}

// Split out because the migration is the one refusal with nobody to tell: it
// runs at boot, ahead of the repaint that clears the note. One name for the
// event either way.
function countWriteRefused() {
  trackWhenReady("storage-refused");
}

// What the name field shows: the active car's own name, because the record is
// the source of truth for it at every car count. The rule is nameFieldValue in
// myCarsUi.js; this binds it to the two pieces of module state it needs, and is
// the only reader, so the two writers of the field both fill it from here.
function carNameForField() {
  return nameFieldValue(activeSavedCar(), prefs.carId === CUSTOM_CAR_ID, prefs.customName);
}

// Does the car on screen carry a name? Read through the same mismatch guard the
// summary uses, so the field and the summary cannot disagree about whether
// there is a name in play.
function activeCarHasName() {
  return Boolean(activeSavedCar()?.name?.trim());
}

// The two things that read a car's name, repainted together. The chips go
// through the one painter rather than being reached into directly, so this does
// not become a second place that knows how a chip is named.
//
// The field is skipped while the user is standing in it: a repaint may not take
// back a keystroke, which is why writeDisplayValues stays the one
// unconditional writer of it.
function repaintCarName() {
  $("carName").textContent = carSummaryText(activeSavedCar(), currentCar());
  const field = $("carNickname");
  if (document.activeElement !== field) field.value = carNameForField();
  renderMyCars();
}

// saveCarName's two callers, which both repaint. The refusal is said AFTER that
// repaint, because the repaint is what clears the note: the same order
// addCurrentCar and removeActiveCar already use.
function writeCarName(text) {
  const wrote = saveCarName(text);
  repaintCarName();
  if (!wrote.ok) sayWriteRefused(nameWriteFailedMessage(wrote.reason));
}

// What LEAVING the field does: an emptied name settles back on the car's default, and never on input.
function settleCarName() {
  const saved = activeSavedCar();
  if (!saved || saved.name?.trim()) return;
  writeCarName(defaultCarName(saved, getCar));
}

function renderMyCars() {
  const cars = myCarsLive ? myCars.cars : [];
  // Asked ONCE and fed to all four visibility rules. Whether the car on screen
  // is in the list now decides four separate things, and four call sites each
  // asking for themselves is four chances to answer differently within one
  // repaint.
  const saved = activeSavedCar();
  const isSaved = Boolean(saved);

  // Cleared on EVERY repaint, not only the ones that follow a selection. boot()
  // paints on load and the name field repaints on every keystroke, and in both
  // the note is already empty, so clearing it costs nothing. What the line is
  // for is the other kind of repaint: a cap refusal from the previous
  // interaction, still sitting next to a car tile that has moved on, reads as a
  // live error. The two messages meant to outlive a repaint are the add and
  // removal announcements, and both are said AFTER it for exactly this reason.
  clearMyCarsNote();

  // The add control follows the CAR, not the count: there has to be one on
  // screen to add, and carTileSource is already the rule for whether there is.
  // It stays visible at the cap, where a tap answers with atCapMessage.
  const add = $("addCarBtn");
  add.hidden = !showsAddControl(myCarsLive, carTileSource(prefs.carId, currentCar(), saved) !== "none");
  add.textContent = addControlLabel(isSaved);

  // Never an act with nothing selected. Hidden on the BUTTON, not on a wrapper
  // around it: focusCarListAction skips a control by reading this exact flag,
  // and a wrapper carrying it left the button's own flag false forever.
  $("removeCarBtn").hidden = !showsRemoveLink(cars.length, isSaved);

  // The name field is not the chrome's to hide. It was the custom car's alone
  // before this feature, and it now also belongs to any car already carrying a
  // name, at any count: see showsNameField for why a name the user cannot reach
  // is worse than a field they do not need.
  //
  // The focus clause is the DOM half of that rule and stays here rather than in
  // the pure one, because it is about a caret and not about a car. Clearing the
  // last character of a name at one car makes showsNameField answer false on
  // the very keystroke that did it, and a field that vanishes mid-edit takes
  // the user's focus and their chance to type it again with it.
  const naming = document.activeElement === $("carNickname");
  $("nicknameField").hidden =
    !naming && !showsNameField(cars.length, prefs.carId === CUSTOM_CAR_ID, activeCarHasName(), isSaved);

  // On screen from the first saved car, whether or not the user is standing on
  // one: it is what an add produces, and the way back to a deselected car.
  const row = $("myCarsRow");
  const chips = showsChipRow(cars.length);
  row.hidden = !chips;
  row.innerHTML = "";
  if (!chips) return;

  const activeId = checkedChipId(saved);
  for (const chip of buildChips(cars, getCar)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "preset my-cars__chip";
    b.dataset.myCarId = chip.id;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", chip.id === activeId ? "true" : "false");
    // The full year-make-model, with the visible text as its prefix so a
    // voice-control user can say the words they can actually see.
    b.setAttribute("aria-label", chip.accessibleName);
    // Roving tabindex: the group is ONE tab stop, and Tab lands on the selected
    // chip. A keyboard user passing through the page steps over the row, not
    // over five buttons inside it.
    b.tabIndex = chip.id === activeId ? 0 : -1;
    const label = document.createElement("span");
    label.className = "my-cars__chip-label";
    label.textContent = chip.label;
    b.appendChild(label);
    row.appendChild(b);
  }

  // Nothing selected is a real state, not a broken one: the store answers null
  // rather than choosing a car on the user's behalf, and checkedChipId answers
  // the same when the two stores point at different cars. A group whose every
  // chip is tabIndex -1 cannot be entered by Tab at all, so park the tab stop
  // on the first chip and leave all of them unchecked.
  if (!cars.some((c) => c.id === activeId)) {
    const first = row.querySelector(".my-cars__chip");
    if (first) first.tabIndex = 0;
  }
}

function myCarChipEls() {
  return [...$("myCarsRow").querySelectorAll(".my-cars__chip")];
}

// The car tile's collapsed summary. The rule is carSummaryLabel in myCarsUi.js,
// where a test can reach it; this binds it to the one piece of module state it
// needs, so every call site asks the same question with the same arguments and
// none of them has to know that customName is still in the chain.
//
// The slot is handed over only for the CUSTOM car, because that is the only car
// it has ever described. An orphan that carries no stored label used to reach
// it too and come out wearing the custom car's name.
function carSummaryText(saved, car) {
  return carSummaryLabel(
    saved,
    car,
    legacyNameSlot(prefs.carId === CUSTOM_CAR_ID, prefs.customName),
  );
}

// Switch to a saved car.
//
// THE CHARGER INPUTS SURVIVE THIS, and that requirement is the entire reason
// this function exists instead of a call to boot(). The energy rate, the
// session fee, the time-of-use and duration rows, the fee and tax rows, the
// rate mode and the "charge for" slider all describe the CHARGER the user is
// standing at, not the car they are standing next to. Switching cars must leave
// every one of them exactly where it was.
//
// What makes that true is the narrowness of what this writes: prefs.carId, the
// three fields in CAR_EDIT_FIELDS, and customName for a custom car.
// writeDisplayValues then repaints the whole form from prefs, which is safe
// precisely because no charger value in prefs was touched. The charger state
// that is NOT in prefs (the schedule rows, the tier rows, the slider, the rate
// mode) lives in the DOM and in module variables and is never rebuilt here.
//
// boot() DOES rebuild all of it, which is why this is not a call to boot():
// doing so would empty a time-of-use schedule the user had just typed in, at
// the exact moment they were comparing two cars against it.
function switchToMyCar(id) {
  if (!myCarsLive) return;
  const res = setActiveMyCar(myCars, id);
  if (!res.ok) return;
  myCars = res.state;
  // Spoken, not obeyed, for the reason selectMyCar gives: this car is on screen
  // by the end of this function either way. Said after the repaint below, which
  // is what clears the note.
  const wrote = saveMyCars(myCars);

  const saved = activeMyCar(myCars);
  if (!saved) return;

  const car = saved.carId && saved.carId !== CUSTOM_CAR_ID ? getCar(saved.carId) : null;
  if (car) {
    prefs = applyCarSelection(prefs, car);
    $("carSearch").value = carLabel(car);
  } else {
    // A custom car, or one whose carId the dataset no longer has. Either way
    // there is no row to fill from, so the saved numbers below are all there is.
    prefs.carId = saved.carId || CUSTOM_CAR_ID;
    // Kept in step with the legacy field for the rollback window, the same way
    // saveCarNumbers writes both stores from one call.
    if (prefs.carId === CUSTOM_CAR_ID) prefs.customName = saved.name || "";
    $("carSearch").value = saved.carId === CUSTOM_CAR_ID ? "My own car" : (saved.label || "");
  }
  prefs = { ...prefs, ...savedCarNumbers(saved, getCar) };
  savePrefs(prefs);

  $("carName").textContent = carSummaryText(saved, car);
  // Deliberately NOT touching $("tweak").open or $("carTile").open. Switching is
  // not picking: the user is comparing two cars they already saved, and folding
  // the panel they are reading out from under them is not a help.
  writeDisplayValues();
  renderMyCars();
  render();
  if (!wrote.ok) sayWriteRefused(selectionWriteFailedMessage(wrote.reason));
}

// --- Removing a car ---------------------------------------------------------
//
// ASKED FIRST, and in a modal. A removal throws away the numbers the user typed
// for that car and nothing in the app puts them back.
//
// showModal() brings the focus trap, Escape, the backdrop and the focus restore
// with it, and it swallows the second press of a double tap.

// Drop the legacy per-car override for a removed car, keeping the two stores in
// step the same way saveCarNumbers does on the way in.
//
// Only once NO saved car points at that dataset row any more. Two saved cars
// may share a carId, which is the whole point of adding a second of one model,
// and clearing on the first removal would take the survivor's numbers with it.
function forgetCarOverride(carId) {
  const all = prefs.carOverrides;
  if (!carId || !all || typeof all !== "object" || !(carId in all)) return;
  if (myCars.cars.some((c) => c.carId === carId)) return;
  const rest = { ...all };
  delete rest[carId];
  prefs = { ...prefs, carOverrides: rest };
  savePrefs(prefs);
}

// Removing the LAST car puts the app back on the screen a first-time visitor
// gets, by clearing the car-shaped prefs and running the same boot() the reset
// button ends on. Anything less leaves "Select your car" next to a battery size
// and an MPG the user can no longer see a car for.
//
// The charger is deliberately untouched, which is where this parts company with
// "Reset everything". The rate, the fees, the tax and the schedule rows describe
// the charger the user is standing at, and they were standing at it a moment
// ago. boot() rebuilds the car tile and the display values only; the rows live
// in the DOM and the rate mode in a module variable, and the reset button
// clears those itself, ahead of the call, precisely because boot does not.
function resetToFirstRunCar() {
  const d = defaultPrefs();
  prefs = {
    ...prefs,
    carId: d.carId, customName: d.customName,
    mpg: d.mpg, miPerKwh: d.miPerKwh, batteryKwh: d.batteryKwh,
  };
  savePrefs(prefs);
  boot();
}

// Where focus goes once a removal has repainted the tile. The dialog hands
// focus back to the control that opened it, and a removal can take that control
// off the screen: at one car left the chrome rule hides it. Letting focus fall
// to <body> loses a keyboard user their place at the one moment they most need
// the list sitting next to it.
//
// The nearest surviving list action, preferring the one the user just pressed,
// and deliberately not a chip: the note that announces the removal sits
// directly below these two, and the chip row sits above the picker.
function focusCarListAction() {
  const at = [$("removeCarBtn"), $("addCarBtn")].find((el) => !el.hidden);
  // Nothing left of this feature on screen means the list is empty, and a
  // first-run screen has one thing to do on it.
  (at ?? $("carSearch")).focus();
}

// Which car the open question is about, pinned when it is asked and checked
// again before it is acted on. Another tab removing this car re-points the
// selection while the modal is open, so re-finding the ACTIVE car on the way
// back would remove a different car than the one the question named.
let removingCarId = null;

// Ask. Only the id and the name are taken; everything else is re-read when the
// answer comes back.
function askRemoveCar() {
  if (!myCarsLive) return;
  const saved = activeMyCar(myCars);
  if (!saved) return;

  const dlg = $("removeCarDialog");
  if (dlg.open) return;
  removingCarId = saved.id;
  // The chip's words, suffix and all. The full year-make-model would name the
  // car that is about to survive whenever two records share a model.
  const question = removeConfirmQuestion(chipLabelFor(myCars.cars, saved.id, getCar));
  $("removeCarPrompt").textContent = question;

  // <dialog> is Firefox 98 and Safari 15.4. Below those, showModal threw inside
  // this handler and the control did nothing at all: no question, no removal,
  // no way to tell the user why. The native confirm loses the focus trap and
  // the double-tap swallow, and it asks the SAME question and spends the answer
  // on the SAME removal, so there is one act here and not two.
  if (typeof dlg.showModal !== "function") {
    if (!window.confirm(question)) return;
    // confirm blocks the task queue, so another tab's storage event has not run
    // yet, and the reconcile below is gated on dlg.open and never reaches here.
    refreshMyCarsFromStore();
    removeActiveCar();
    return;
  }

  // Cleared rather than trusted: not every engine resets it on show.
  dlg.returnValue = "";
  dlg.showModal();
}

function removeActiveCar() {
  if (!myCarsLive) return;
  // THE CAR THE QUESTION NAMED, and it may be gone: another tab can remove it
  // while the modal is open.
  const saved = myCars.cars.find((c) => c.id === removingCarId) ?? null;
  if (!saved) return;

  // Read BEFORE the removal, because a moment later there is no record left to
  // build the announcement from.
  const label = chipBaseLabel(saved, getCar);

  const res = removeMyCar(myCars, saved.id);
  if (!res.ok) return;

  // THE WRITE DECIDES, not the list operation, which is the shape addCurrentCar
  // already uses one function away. saveMyCars refuses when storage is
  // unavailable or a newer build's payload is on disk, and the return used to
  // be discarded over an already-mutated myCars: the chip vanished, the note
  // said the car was gone, the disk still held it, and the next reload brought
  // it back. On a shared device that sentence is a false assurance that data
  // was deleted. `res.state` is dropped rather than kept, so the screen and the
  // disk still agree about what is saved.
  const wrote = saveMyCars(res.state);
  if (!wrote.ok) {
    sayWriteRefused(removeWriteFailedMessage(wrote.reason));
    return;
  }
  myCars = res.state;
  // Only once the removal is real. The legacy override is the rollback, so
  // clearing it for a car that is still on disk would take that car's numbers
  // with it and leave nothing to roll back to.
  forgetCarOverride(saved.carId);

  // The successor is READ BACK, not chosen here: removeMyCar owns which car is
  // selected after a removal, and a second opinion at this call site would
  // drift from it the first time either one changed.
  const next = activeMyCar(myCars);
  if (next) switchToMyCar(next.id);
  else resetToFirstRunCar();

  // After the repaint, which clears the note. The chip row vanishing is not
  // feedback a screen reader gets, so this line is the whole of what it hears.
  sayMyCarsNote(removedMessage(label));
  focusCarListAction();
}

// --- Two tabs ---------------------------------------------------------------
//
// Every tab holds the whole list in memory and saveMyCars writes all of it, so
// a tab that has not read the disk since another tab wrote to it saves that
// tab's cars away on its next ordinary act: a rename in a stale tab silently
// destroyed a car added in a fresh one, and an open remove question answered in
// a stale tab took two cars instead of the one it named.
//
// ONE function, reached from both triggers. Two implementations of "reload from
// disk" is the same two-writers defect one layer up.

// Re-read the store and repaint. A READ, and that is the contract: a write from
// here would fire a `storage` event in the tab that caused the refresh, and two
// tabs answering each other's writes never stop.
//
// It repaints the LIST and the two places the active car is NAMED, and nothing
// else. The number fields are deliberately left alone: they hold what this
// tab's user is editing, this tab is their last writer, and repainting them
// would refill a field cleared mid-edit with the value that was just deleted.
// A cross-tab edit of the same car's numbers is therefore last-write-wins per
// field, which is a keystroke, where this defect was a whole car.
function refreshMyCarsFromStore() {
  if (!myCarsLive) return;

  // Read against the OLD list, which is the only one that still holds the car
  // if this refresh is the one that takes it away.
  const dlg = $("removeCarDialog");
  const asked = dlg.open ? chipLabelFor(myCars.cars, removingCarId, getCar) : "";

  myCars = namedState(refreshMyCars(myCars.activeId));

  // The question named a car that is now gone. Closed rather than re-pointed:
  // an answer given about one car must not be spent on another.
  const questionGone = dlg.open && !myCars.cars.some((c) => c.id === removingCarId);
  if (questionGone) dlg.close("");

  repaintCarName();

  // After the repaint, which clears the note, and focus after that: close()
  // hands it back to a control the repaint above may have just hidden.
  if (questionGone) {
    sayMyCarsNote(removeGoneMessage(asked));
    focusCarListAction();
  }
}

// What the estimate caps against: a car-shaped carrier whose chargeKw is the
// selected car's onboard ceiling.
//
// savedCarCeilingKw answers with the live dataset row while the carId still
// resolves, and with the snapshot taken when the car was saved when it does
// not. That second case is why maxKw exists: a reseed that drops a carId used
// to leave the car bounded only by the outlet, and the charge-time estimate
// came out fast in the app's own voice.
//
// A carrier rather than a plain number so the Math.min that APPLIES a ceiling
// stays in chargeDrawKw and the rule for what a ceiling IS stays in
// savedCarCeilingKw. Restating either here is how this app came to hold two
// definitions of charge power in the first place. carCeilingKw reads chargeKw
// and nothing else, so an Infinity carrier answers Infinity exactly as a car
// with no figure does.
function ceilingCar() {
  const saved = activeSavedCar();
  return saved ? { chargeKw: savedCarCeilingKw(saved, getCar) } : currentCar();
}

// Highlight the charger-speed preset that matches the current power, if any.
// The car is not consulted: the field and the presets are both outlet rates.
function updatePresetActive() {
  const kw = parseNum($("powerKw").value);
  for (const btn of document.querySelectorAll("#powerPresets .preset")) {
    btn.classList.toggle("is-active", presetMatchesKw(kw, parseNum(btn.dataset.kw)));
  }
}

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
  const distDisp = (prefs.units === "metric" || prefs.units === "kmL") ? U.kmFromMiles(distMiles) : distMiles;
  return {
    min: stopMin,
    soc: Math.round(best.soc),
    range: Math.round(distDisp),
    rangeUnit: U.labels(prefs.units).distance,
    equiv: money(equivDisp, cur),
    unit: prefs.units === "imperial" ? "/gal" : "/L",
    pct,
  };
}

// The best-value stop for a per-hour time fee. Past the charge taper you pull
// little energy while the clock keeps running, so the all-in $/kWh bottoms out
// before 100% (chargeCurve tracks that point as bestMin). Returns the same
// gas-equivalent framing as the hero, plus whether that stop is a confident win
// (`worth`) and how many points it beats a full charge by (`improvesBy`), so
// the caller can pick "charge it + note" vs "charge briefly". Null when there's
// no meaningfully-earlier stop to recommend.
function timeFeeSweetSpot(full, curveArgs, m, cur, breakeven) {
  if (!(m.mpg > 0) || !(m.miPerKwh > 0)) return null;
  const stopMin = full.bestMin;
  if (!(stopMin > 0) || !(stopMin < full.fullMinutes - 2)) return null; // not meaningfully earlier
  const best = chargeCurve({ ...curveArgs, capMinutes: stopMin });
  const eff = best.effectivePerKwh;
  if (!(eff > 0)) return null;
  const gpm = m.gasPrice / m.mpg;
  const pctOf = (e) => (gpm > 0 ? Math.round(((gpm - e / m.miPerKwh) / gpm) * 100) : 0);
  const pct = pctOf(eff);
  const fullPct = Number.isFinite(full.effectivePerKwh) ? pctOf(full.effectivePerKwh) : 0;
  const equivGas = (eff * m.mpg) / m.miPerKwh; // canonical $/gallon
  const equivDisp = U.gasPriceForDisplay(equivGas, prefs.units);
  const distMiles = m.miPerKwh * best.kwhIntoBattery; // canonical miles added
  const distDisp = (prefs.units === "metric" || prefs.units === "kmL") ? U.kmFromMiles(distMiles) : distMiles;
  return {
    min: stopMin,
    soc: Math.round(best.soc),
    range: Math.round(distDisp),
    rangeUnit: U.labels(prefs.units).distance,
    equiv: money(equivDisp, cur),
    unit: prefs.units === "imperial" ? "/gal" : "/L",
    pct,
    worth: verdict(eff, breakeven) === "worth",
    improvesBy: pct - fullPct,
  };
}

// The "Charge for" slider spans 0 to the full-charge time. It only shows when a
// time fee makes a shorter charge worth considering. Untouched, it sits at the
// full charge so nothing changes; drag it back to price a partial top-up.
function updateChargeSlider(show, fullChargeMin, curMin, curSoc, hasTimeFeeContext = true) {
  const field = $("chargeForField");
  field.hidden = !show;
  if (!show) return;
  const slider = $("chargeForMin");
  const maxMin = Math.max(15, Math.ceil(fullChargeMin));
  slider.max = String(maxMin);
  // Follow the current selection (a dragged cap, the recommended partial, or the
  // full charge) so the slider and the numbers around it always agree.
  slider.value = String(Math.max(0, Math.min(maxMin, Math.round(curMin))));
  $("chargeForOut").textContent = `${formatDuration(Number(slider.value))} (~${Math.round(curSoc)}%)`;
  $("chargeForNote").textContent = Number(slider.value) >= maxMin - 0.5
    ? "Full charge to your target."
    : (hasTimeFeeContext
        ? "Stopping early: less energy, but less time fee."
        : "Stopping early: less energy, and you skip the pricier later rate.");
}

function renderAdvanced(m, be, cur, session, effective, timeFee, drawKw) {
  // Lead with range added (the tangible benefit), keep kWh for pricing context.
  const kwhIn = session.kwhIntoBattery;
  if (Number.isFinite(kwhIn) && kwhIn > 0) {
    const kwhStr = `${kwhIn.toFixed(1)} kWh`;
    if (Number.isFinite(m.miPerKwh) && m.miPerKwh > 0) {
      const dist = m.miPerKwh * kwhIn; // canonical miles
      const distDisp = (prefs.units === "metric" || prefs.units === "kmL") ? U.kmFromMiles(dist) : dist;
      $("advKwh").textContent = `${Math.round(distDisp)} ${U.labels(prefs.units).distance} \u00b7 ${kwhStr}`;
    } else {
      $("advKwh").textContent = kwhStr;
    }
  } else {
    $("advKwh").textContent = "-";
  }
  // The power field holds the OUTLET, so on a car whose onboard charger is
  // slower the estimate runs at a rate that appears nowhere on screen until
  // both prices are in and the verdict card's timeline shows up. This row
  // always renders and sits in the same disclosure as the presets, so it names
  // the rate here. In the label rather than the value because the rate is
  // context and the duration is the answer: muted keeps it from reading as a
  // warning. Only when the cap actually bites, since a car that can take the
  // whole outlet would just repeat the field two rows above.
  const capped = Number.isFinite(drawKw) && Number.isFinite(m.powerKw) && drawKw < m.powerKw - 0.05;
  const hasTime = Number.isFinite(session.minutes) && session.minutes > 0;
  $("advTimeLabel").textContent = capped && hasTime
    ? `Time at ${round(drawKw, 2)} kW (est.)`
    : "Time to charge (est.)";
  $("advTime").textContent = formatDuration(session.minutes);
  const tfRow = $("advTimeFeeRow");
  if (timeFee > 0) {
    tfRow.hidden = false;
    $("advTimeFee").textContent = money(timeFee, cur);
  } else {
    tfRow.hidden = true;
  }
  // Bottom line: the all-in dollar cost of this charge. Only meaningful once a
  // rate is set (effective is finite) and we know the battery size to bill an
  // actual amount of energy against.
  const totalRow = $("advTotalRow");
  if (Number.isFinite(effective) && session.kwhFromCharger > 0 && Number.isFinite(session.totalCost)) {
    totalRow.hidden = false;
    $("advTotal").textContent = money(session.totalCost, cur);
  } else {
    totalRow.hidden = true;
  }
}

// --- Units picker ---
// Each system's compact trigger label plus the clearer open-menu row. "Metric"
// alone is ambiguous now (two metric systems), so the two metric triggers show
// their economy unit (L/100km vs km/L).
const UNIT_SYSTEMS = [
  { system: "imperial", trigger: "US", menu: "US (mpg, gallon)" },
  { system: "uk", trigger: "UK", menu: "UK (mpg, litre)" },
  { system: "metric", trigger: "L/100km", menu: "Metric (L/100km)" },
  { system: "kmL", trigger: "km/L", menu: "Metric (km/L)" },
];

function unitTriggerLabel(system) {
  const u = UNIT_SYSTEMS.find((x) => x.system === system);
  return u ? u.trigger : "US";
}

function applyUnitLabels() {
  const L = U.labels(prefs.units);
  const cur = prefs.currency;
  $("unitBtn").textContent = unitTriggerLabel(prefs.units);
  renderUnitMenu();
  $("gasPriceLabel").textContent = `Gas price (${cur}/${L.gasVolume})`;
  $("yourRateLabel").textContent = `Energy rate (${cur}/kWh)`;
  $("mpgLabel").textContent = `Gas ${L.fuelEconomy}`;
  $("effLabel").textContent = `Electric ${L.evEfficiency}`;
}

function writeDisplayValues() {
  const s = prefs.units;
  // Prices show at up to 6 decimals (trailing zeros trimmed) so switching
  // currency/units or picking a car never rounds away what the user typed
  // (e.g. 3.899, 0.257). Results are still rounded to 2 dp by money().
  paint("gasPrice", U.gasPriceForDisplay(prefs.gasPrice, s), 6, prefs.gasPrice);
  paint("yourRate", prefs.yourRate, 6);
  paint("mpg", U.economyForDisplay(prefs.mpg, s), 2, prefs.mpg);
  paint("miPerKwh", U.efficiencyForDisplay(prefs.miPerKwh, s), 2, prefs.miPerKwh);
  paint("batteryKwh", prefs.batteryKwh, 2);
  paint("sessionFee", prefs.sessionFee, 2);
  paint("powerKw", prefs.powerKw, 2);
  $("startPct").value = prefs.startPct;
  $("targetPct").value = prefs.targetPct;
  // Keep the invariant even if a stored/edge value has start > target.
  if (parseNum($("startPct").value) > parseNum($("targetPct").value)) {
    $("startPct").value = $("targetPct").value;
  }
  $("startPctOut").textContent = `${$("startPct").value}%`;
  $("targetPctOut").textContent = `${$("targetPct").value}%`;
  $("carNickname").value = carNameForField();
  for (const id of ["curSym1", "curSym2", "curSym3"]) $(id).textContent = prefs.currency;
  // Dynamic pricing rows bake the symbol in at creation; refresh them too on a currency change.
  for (const el of document.querySelectorAll("#touRows .input-money__sym, #durRows .input-money__sym, #timeFeeRows .input-money__sym")) {
    el.textContent = prefs.currency;
  }
  $("currencyBtn").textContent = prefs.currency;
  renderCurrencyMenu();
}

function round(n, d) {
  if (!Number.isFinite(n)) return "";
  const f = Math.pow(10, d);
  return String(Math.round(n * f) / f);
}

// What each field was last painted with: { text, value }, read back by
// readInputs to tell an untouched field from a typed one.
const painted = new Map();

// Write one value into its field, remembering the canonical value behind it.
function paint(id, display, digits, canonical = display) {
  const text = round(display, digits);
  $(id).value = text;
  painted.set(id, { text, value: canonical });
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

// The fee/schedule editor rows (time-of-day, by-duration, station-time, tax)
// are built and read in ./editorRows.js.

// Reflect the selected pricing mode: show the right editor, and disable the flat
// charger-price field when a schedule/tier mode is driving the result instead.
function applyRateMode() {
  $("touEditor").hidden = rateMode !== "tod";
  $("durEditor").hidden = rateMode !== "dur";

  const rateInput = $("yourRate");
  const field = rateInput.closest(".field");
  if (rateMode === "flat") {
    rateInput.disabled = false;
    field.classList.remove("is-disabled");
  } else {
    rateInput.disabled = true;
    field.classList.add("is-disabled");
  }

  if (rateMode === "tod" && $("touRows").children.length === 0) {
    addTouRow(prefs.currency, "00:00", "");
    addTouRow(prefs.currency, "16:00", "");
  }
  if (rateMode === "dur" && $("durRows").children.length === 0) {
    addDurRow(prefs.currency, 0, "");
    addDurRow(prefs.currency, 60, "");
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

// --- Units picker (a dropdown mirroring the currency picker) ---
// Switch to an explicit unit system. Values in `prefs` are canonical, so we
// capture any in-progress edits first, flip the flag, then relabel/re-render.
// Commit a units choice; the dropdown component owns open/close and focus.
function chooseUnit(system) {
  const m = readInputs();
  persistFrom(m); // capture edits made in the current units first
  prefs.units = system;
  savePrefs(prefs);
  applyUnitLabels(); // relabels #unitBtn and re-renders the menu
  writeDisplayValues();
  render();
}

// Re-render the units menu after the selection changes.
function renderUnitMenu() {
  if (unitDropdown) unitDropdown.render();
}

// Currency is display-only (both prices are entered in the user's own currency),
// so switching it just relabels and re-renders without touching any values.
function setCurrency(sym) {
  const m = readInputs();
  persistFrom(m); // keep any in-progress edits before re-rendering
  prefs.currency = sym;
  savePrefs(prefs);
  applyUnitLabels();
  writeDisplayValues();
  render();
}

// Currency picker options: `sym` is the symbol shown app-wide (and stored in
// prefs.currency); `name` labels the open menu row. The closed trigger shows
// only the symbol; the open menu shows aligned symbol + name rows, because the
// native OS select menu can't be styled to line those up.
const CURRENCIES = [
  { sym: "$", name: "US Dollar" },
  { sym: "\u20AC", name: "Euro" },
  { sym: "\u00A3", name: "Pound" },
  { sym: "\u00A5", name: "Yen" },
  { sym: "\u20B9", name: "Rupee" },
  { sym: "\u20A9", name: "Won" },
  { sym: "Fr", name: "Franc" },
  { sym: "kr", name: "Krona" },
  { sym: "R$", name: "Real" },
  { sym: "A$", name: "Australian $" },
  { sym: "C$", name: "Canadian $" },
  { sym: "\u20BD", name: "Ruble" },
];

// Re-render the currency menu after the selection changes.
function renderCurrencyMenu() {
  if (currencyDropdown) currencyDropdown.render();
}

// --- Car selection ---
// The sentinel is imported, not restated. main.js used to hold its own copy of
// the literal, which is two definitions of one identity and no mechanism to
// keep them equal.

// keepCustom used to ride along here as an option no call site passed. It was
// harmless while nothing read it; the saved-car line below reads it, which
// turns a dead parameter into a live branch that only the deleted caller could
// ever reach. Removed rather than commented, because a branch no caller takes
// is not reserved capacity, it is an untested path that reads as a tested one.

function setCar(car) {
  // applyCarSelection owns which fields a car fills in, and which it must leave
  // alone, powerKw above all.
  prefs = applyCarSelection(prefs, car);
  // Picking SHOWS this car. The record becomes the active one if the user has
  // already saved this car, and nothing is selected if they have not, so the
  // numbers below come from the record when there is one and from the dataset
  // row applyCarSelection just read when there is not. Growing the list is
  // addCurrentCar's job and no part of this one.
  const { saved, wrote } = selectMyCar(car.id);
  if (saved) prefs = { ...prefs, ...savedCarNumbers(saved, getCar) };
  savePrefs(prefs);
  $("carName").textContent = carSummaryText(saved, car);
  $("carSearch").value = carLabel(car);
  $("tweak").open = false;
  writeDisplayValues();
  // renderMyCars owns nicknameField.hidden now, so the assignment that used to
  // sit here is gone rather than duplicated: two writers of one flag is how the
  // field ends up visible for a car that has no name to put in it.
  renderMyCars();
  render();
  // After the repaint, which clears the note. The same order the add and the
  // removal use.
  if (!wrote.ok) sayWriteRefused(selectionWriteFailedMessage(wrote.reason));
}

// Switch to a user-defined car: keep the current numbers, drive the label from
// the nickname, and reveal the numbers so the user can enter their own.
function setCustomCar() {
  prefs.carId = CUSTOM_CAR_ID;
  // Restore this custom car's saved numbers if we have them; otherwise keep
  // whatever's showing so the user can adjust from there.
  //
  // The saved record answers first, and it answers nothing when the user has
  // never edited a custom car, because it has no dataset row to inherit from.
  // That is the same silence carOverrides gives in the same situation, which is
  // what makes swapping the source here invisible. The override stays the
  // fallback for a selection the store could not represent.
  const { saved, wrote } = selectMyCar(CUSTOM_CAR_ID);
  const ov = saved ? savedCarNumbers(saved, getCar) : (prefs.carOverrides ? prefs.carOverrides[CUSTOM_CAR_ID] : null);
  if (ov) {
    if (Number.isFinite(ov.mpg)) prefs.mpg = ov.mpg;
    if (Number.isFinite(ov.miPerKwh)) prefs.miPerKwh = ov.miPerKwh;
    if (Number.isFinite(ov.batteryKwh)) prefs.batteryKwh = ov.batteryKwh;
  }
  savePrefs(prefs);
  $("carName").textContent = carSummaryText(saved, null);
  $("carSearch").value = "My own car";
  $("tweak").open = true;
  $("carTile").open = true;
  writeDisplayValues();
  renderMyCars(); // reveals nicknameField: a custom car always gets a name field
  render();
  // After the repaint, which clears the note, and before focus moves.
  if (!wrote.ok) sayWriteRefused(selectionWriteFailedMessage(wrote.reason));
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

// This is a combobox, not a menu: focus stays in the text field the whole time
// so typing keeps working, and the "which row am I on" state that focus would
// normally carry has to be tracked by hand and published as
// aria-activedescendant. That is the one real difference from dropdown.js,
// where the rows take DOM focus outright.
const carOptionId = (i) => `carOption-${i}`;
// Index into the rendered .combo__item rows, or -1 for "none, the caret is
// still just in the text field". Mouse hover deliberately does not move it.
let carActiveIndex = -1;
// The text Escape puts back. It is sampled at the two moments the field is
// settled, focus and close, and never while the list is open. Every close is a
// real one: the deferred blur close is cancelled on refocus, so a timer from a
// blur the user already undid cannot land mid-query and bank a half-typed
// search. It cannot be sampled on open: typing is itself an open, and by the
// time the input event runs the keystroke is already in the value, so opening
// that way would bank the character the user is about to ask us to throw away.
let carRestoreValue = "";
// The pending deferred close from a blur, held so a refocus can cancel it.
let carBlurTimer = null;

function carOptionEls() {
  return [...$("carResults").querySelectorAll(".combo__item")];
}

// Single place that paints the active row: the attribute a screen reader
// follows and the styling everyone else sees, set together so they cannot drift.
function setCarActive(index) {
  const items = carOptionEls();
  carActiveIndex = index >= 0 && index < items.length ? index : -1;
  items.forEach((li, i) => {
    const on = i === carActiveIndex;
    li.classList.toggle("combo__item--active", on);
    li.setAttribute("aria-selected", on ? "true" : "false");
  });
  const active = carActiveIndex >= 0 ? items[carActiveIndex] : null;
  if (!active) {
    $("carSearch").removeAttribute("aria-activedescendant");
    return;
  }
  $("carSearch").setAttribute("aria-activedescendant", active.id);
  // "nearest" scrolls the 46vh results panel and leaves the page alone.
  active.scrollIntoView({ block: "nearest" });
}

// The add and remove controls, moved out of the open list's way. Hidden rather
// than disabled, because [hidden] takes the row out of the tab order too;
// showsCarListActions is the rule and says why.
//
// The row is the only thing written here. The two controls inside it keep their
// own flags, and renderMyCars stays the only writer of those.
function paintCarListActions(listOpen) {
  const row = $("myCarsActions");
  // Focus cannot be left standing on a row that is about to be display:none.
  // The search field is where it goes because the open list belongs to it.
  if (listOpen && row.contains(document.activeElement)) $("carSearch").focus();
  row.hidden = !showsCarListActions(listOpen);
}

function renderCarResults(query) {
  const ul = $("carResults");
  ul.innerHTML = "";

  const custom = document.createElement("li");
  custom.className = "combo__item combo__item--custom";
  custom.id = carOptionId(0);
  custom.dataset.id = CUSTOM_CAR_ID;
  custom.setAttribute("role", "option");
  custom.setAttribute("aria-selected", "false");
  custom.textContent = "\u270F\uFE0F My own car (enter numbers)";
  ul.appendChild(custom);

  const results = filterCars(query);
  results.forEach((car, i) => {
    const li = document.createElement("li");
    li.className = "combo__item";
    li.id = carOptionId(i + 1); // the custom row is always option 0
    li.dataset.id = car.id;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", "false");
    li.textContent = carLabel(car);
    ul.appendChild(li);
  });
  if (!results.length && query.trim()) {
    const none = document.createElement("li");
    none.className = "combo__none";
    // A listbox may only contain options, so a bare <li> here was a malformed
    // child the whole time. It is a message and not a choice, hence disabled,
    // and it carries no .combo__item class so the arrow keys skip past it.
    none.setAttribute("role", "option");
    none.setAttribute("aria-disabled", "true");
    none.setAttribute("aria-selected", "false");
    // This used to read "No matches, try a make or model.", which sent people
    // back to search differently for a car that is not in the dataset. The way
    // out is the custom row, which is sitting directly above this message as
    // the first option in the same list, so point at it instead. Same wording
    // as the (i) note above the field, so the two agree.
    none.textContent = "No match. Pick \u201cMy own car\u201d at the top to enter your own.";
    ul.appendChild(none);
  }

  ul.hidden = false;
  $("carSearch").setAttribute("aria-expanded", "true");
  paintCarListActions(true);
  // The rows underneath just changed, so any previously active one is gone.
  setCarActive(-1);
}

function hideCarResults() {
  $("carResults").hidden = true;
  $("carSearch").setAttribute("aria-expanded", "false");
  paintCarListActions(false);
  // Every row is still in the DOM here; renderCarResults is what replaces them.
  // This clears because the listbox is hidden as of the top of this function,
  // and an active option inside a hidden listbox points a screen reader at a
  // row the user can no longer see or move to.
  $("carSearch").removeAttribute("aria-activedescendant");
  carActiveIndex = -1;
  // Whatever the field reads now is the baseline the next search starts from,
  // whether a selection just wrote a label into it, Escape just put the old
  // text back, Enter dismissed the list, or a blur left the typing where it
  // stood. Escape reaching here re-banks the value it restored a line earlier,
  // which is a no-op by construction.
  carRestoreValue = $("carSearch").value;
}

// --- Events ---
let copyToastTimer = null;

function showCopyToast(message) {
  document.querySelector(".toast--copy")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast toast--copy";
  toast.setAttribute("role", "status");
  // The update toast is pinned to the same spot, so sit above it rather than on it.
  if (document.querySelector(".toast:not(.toast--copy)")) toast.classList.add("toast--stacked");
  const text = document.createElement("span");
  text.className = "toast__text";
  toast.append(text);
  document.body.appendChild(toast);
  // Fill after insertion: a live region that arrives already populated is not
  // reliably announced, and this toast is the only confirmation of the copy.
  requestAnimationFrame(() => { text.textContent = message; });
  clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => toast.remove(), 2500);
}

function attachEvents() {
  const liveIds = ["gasPrice", "yourRate", "mpg", "miPerKwh", "batteryKwh", "sessionFee", "powerKw"];
  for (const id of liveIds) $(id).addEventListener("input", render);

  // Remember the user's edits per car: tweaking the car numbers saves an
  // override keyed to the current car, so switching away and back restores them.
  // Watch exactly the fields applyCarEdit copies (CAR_EDIT_FIELDS is the one
  // list), so widening this loop can't smuggle a non-car field into a car.
  for (const id of CAR_EDIT_FIELDS) {
    $(id).addEventListener("input", () => {
      if (!prefs.carId) return;
      const wrote = saveCarNumbers(readInputs());
      if (!wrote.ok) sayWriteRefused(numbersWriteFailedMessage(wrote.reason));
    });
  }

  // These fields are text inputs (so decimal-comma locales can type a comma)
  // with an inputmode for the numeric keypad; identify them by inputmode, not
  // type. Focusing selects the contents ONLY while a field still holds its
  // untouched default, so one keystroke replaces it; once you've typed your own
  // value, focusing leaves it alone so you can edit/append.
  const isNumField = (el) => el && el.tagName === "INPUT" &&
    (el.inputMode === "decimal" || el.inputMode === "numeric");
  const touchedFields = new WeakSet();
  document.addEventListener("input", (e) => {
    if (isNumField(e.target)) touchedFields.add(e.target);
  });
  // Block typing a character that isn't a digit or decimal separator, so unwanted
  // input (letters, a currency symbol, %, spaces) never appears. Using beforeinput
  // lets the browser keep the caret naturally; deletions and navigation pass
  // through, and pasted junk is normalized/cleared on blur.
  document.addEventListener("beforeinput", (e) => {
    const el = e.target;
    if (!isNumField(el)) return;
    if (e.inputType === "insertText" && e.data && /[^\d.,]/.test(e.data)) {
      e.preventDefault();
    }
  });
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (isNumField(el) && !touchedFields.has(el)) {
      requestAnimationFrame(() => { try { el.select(); } catch (_) { /* ignore */ } });
    }
  });

  // Numbers never need more than 2 decimals: round on commit (blur/Enter). This
  // also normalizes a decimal comma to a dot so the displayed value is canonical.
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!isNumField(el) || el.value.trim() === "") return;
    const n = parseNum(el.value);
    if (Number.isFinite(n)) {
      const rounded = Math.round(n * 100) / 100;
      if (String(rounded) !== el.value) {
        el.value = String(rounded);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      // No usable number (e.g. "abc") - clear it so the field never keeps junk
      // once you leave it. (Mobile keypads block letters; this covers desktop.)
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
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
    track("feature-charge-for-slider");
    render();
  });

  // Currency + units pickers: custom dropdowns (native selects can't be styled
  // or lay out the symbol + name rows). Both use the shared dropdown component,
  // which handles open/close, outside-click, and keyboard nav.
  currencyDropdown = createDropdown({
    trigger: "currencyBtn",
    menu: "currencyMenu",
    itemClass: "currency-item",
    options: () => CURRENCIES,
    getValue: () => prefs.currency,
    optionValue: (c) => c.sym,
    renderItem: (li, c) => {
      const sym = document.createElement("span");
      sym.className = "currency-item__sym";
      sym.textContent = c.sym;
      const name = document.createElement("span");
      name.className = "currency-item__name";
      name.textContent = c.name;
      li.append(sym, name);
    },
    onChange: (sym) => setCurrency(sym),
  });
  unitDropdown = createDropdown({
    trigger: "unitBtn",
    menu: "unitMenu",
    itemClass: "unit-item",
    options: () => UNIT_SYSTEMS,
    getValue: () => prefs.units,
    optionValue: (u) => u.system,
    renderItem: (li, u) => { li.textContent = u.menu; },
    onChange: (system) => chooseUnit(system),
  });
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
    addTouRow(prefs.currency);
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
    addDurRow(prefs.currency);
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
    // Presets are the outlet's rate (Level 1 / Level 2), so each writes exactly
    // the number on its label. Nothing on this path is capped: a car-derived
    // value here would flow through readInputs into m.powerKw and on into
    // storage, where it would outlive the car that produced it and shorten the
    // next car's estimate. The ceiling belongs at chargeDrawKw in render().
    paint("powerKw", parseNum(btn.dataset.kw), 2);
    render();
  });

  $("timeFeeAdd").addEventListener("click", () => {
    addTimeFeeRow(prefs.currency);
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

  $("taxAdd").addEventListener("click", () => {
    addTaxRow();
    render();
  });
  $("taxRows").addEventListener("input", render);
  $("taxRows").addEventListener("click", (e) => {
    if (e.target.classList.contains("tou-del")) {
      e.target.closest(".tou-row").remove();
      render();
    }
  });

  // Info notes: show on hover/focus (desktop), tap to pin open (touch). A pinned
  // note dismisses on Escape or a pointer/focus event outside it - not only by
  // tapping the (i) again.
  const wireInfo = (btnId, noteId) => {
    const infoBtn = $(btnId), infoNote = $(noteId);
    if (!infoBtn || !infoNote) return;
    infoBtn.setAttribute("aria-controls", noteId);
    // The note is `hidden`, so it is absent from the accessibility tree and a
    // screen reader can never reach it. aria-describedby resolves THROUGH the
    // hidden attribute (checked in Chrome's accessibility tree: the computed
    // description is byte-identical hidden or shown), so associating it
    // announces the text without revealing the note. It goes on the input the
    // note explains, so it arrives with the thing it is about. The two notes
    // that head a group of rows have no single input, so their (i) carries it.
    // Never both: the (i) sits immediately before its input in the tab order,
    // so describing both would read the same paragraph out twice in a row.
    const labelled = infoBtn.closest(".field-label-row")?.querySelector("label[for]");
    const described = (labelled && $(labelled.htmlFor)) || infoBtn;
    described.setAttribute("aria-describedby", noteId);
    let pinned = false;
    const show = (v) => {
      infoNote.hidden = !v;
      infoBtn.setAttribute("aria-expanded", String(v));
    };
    const outside = (e) => !infoBtn.contains(e.target) && !infoNote.contains(e.target);
    const onDocDown = (e) => { if (outside(e)) setPinned(false); };
    // Focus can move from the (i) INTO the note: it ends in a source link, and a
    // visible link is focusable. Tab, and the browser picks that link as the next
    // stop, which blurs the (i) - and hiding the note on that blur takes the link
    // out of the document before the focus lands on it, so the focus lands
    // nowhere and the browser drops it on <body>. The link's own focus event
    // never fires at all. That was the dead Tab stop: one keypress that moves
    // nothing and leaves a keyboard user with no position in the page.
    //
    // The note stays open while focus is anywhere inside the pair, so the link
    // is reachable rather than unreachable. Making it unfocusable would also
    // have removed the dead stop, by removing the only way to get to the one
    // link in the note, which is not a fix.
    const holdsFocus = () => infoBtn.contains(document.activeElement) || infoNote.contains(document.activeElement);
    // On blur/focusout, relatedTarget is where focus is GOING (null when it
    // leaves the page). document.activeElement is still the old element here,
    // so it cannot answer this question.
    const leaving = (e) => !e.relatedTarget || !(infoBtn.contains(e.relatedTarget) || infoNote.contains(e.relatedTarget));
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      // Escape with focus inside the note has the same problem: hide first and
      // the focus falls to <body>. Hand it back to the (i), which is where the
      // note was opened from. Done while still pinned so the (i)'s own focus
      // handler stays quiet and doesn't reopen what Escape just closed.
      if (infoNote.contains(document.activeElement)) {
        infoBtn.focus();
        setPinned(false);
        return;
      }
      setPinned(false);
      infoBtn.blur();
    };
    const setPinned = (v) => {
      if (v === pinned) { show(v); return; }
      pinned = v;
      show(v);
      // Capture-phase so we still catch clicks on elements that stop propagation.
      if (v) {
        document.addEventListener("pointerdown", onDocDown, true);
        document.addEventListener("keydown", onKey, true);
      } else {
        document.removeEventListener("pointerdown", onDocDown, true);
        document.removeEventListener("keydown", onKey, true);
      }
    };
    infoBtn.addEventListener("mouseenter", () => { if (!pinned) show(true); });
    // Moving the mouse away must not close a note the keyboard is standing in.
    infoBtn.addEventListener("mouseleave", () => { if (!pinned && !holdsFocus()) show(false); });
    infoBtn.addEventListener("focus", () => { if (!pinned) show(true); });
    infoBtn.addEventListener("blur", (e) => { if (!pinned && leaving(e)) show(false); });
    // focusout bubbles, so this covers the link and anything added to the note later.
    infoNote.addEventListener("focusout", (e) => { if (!pinned && leaving(e)) show(false); });
    infoBtn.addEventListener("click", (e) => { e.stopPropagation(); setPinned(!pinned); });
  };
  wireInfo("carInfoBtn", "carInfoNote");
  wireInfo("batteryInfoBtn", "batteryInfoNote");
  wireInfo("powerInfoBtn", "powerInfoNote");
  wireInfo("timeFeeInfoBtn", "timeFeeInfoNote");
  wireInfo("taxInfoBtn", "taxInfoNote");

  // Bookkeeping only: opening here hid the actions row for a Tab passing through.
  $("carSearch").addEventListener("focus", (e) => {
    track("car-search-focused"); // diagnostic: did they engage the first step at all?
    // A close still pending from a blur belongs to a blur this focus just undid.
    // Left to land it closes the list the user is typing into and banks that
    // half-typed query as the Escape value, so drop it here rather than teach
    // hideCarResults to second-guess whoever called it.
    clearTimeout(carBlurTimer);
    // boot() fills this field from saved prefs without the list ever closing,
    // so first focus is the only chance to bank that label before the list opens.
    carRestoreValue = e.target.value;
    e.target.select();
  });

  // Click, type or arrow to open. A click is the mouse half of what focus used
  // to do, and it fires on tap too, so nothing is lost on a phone.
  $("carSearch").addEventListener("click", (e) => {
    if ($("carResults").hidden) renderCarResults(pickerOpenQuery(e.target.value));
  });
  $("carSearch").addEventListener("input", (e) => renderCarResults(e.target.value));
  // Deferred so a mousedown on a row lands before the list goes away.
  $("carSearch").addEventListener("blur", () => {
    carBlurTimer = setTimeout(hideCarResults, 120);
  });

  // One commit path for both mouse and keyboard, so the two cannot diverge.
  // keepFocus is the difference between them: a click is a finished gesture, but
  // a keyboard user who is dropped onto <body> has lost their place in the tab
  // order, so Enter leaves them in the field they were already in.
  const chooseCarOption = (li, { keepFocus = false } = {}) => {
    const id = li?.dataset.id;
    if (!id) return;
    if (id === CUSTOM_CAR_ID) setCustomCar(); // this one moves focus to mpg on purpose
    else { const car = getCar(id); if (car) setCar(car); }
    hideCarResults();
    if (!keepFocus) $("carSearch").blur();
  };

  $("carResults").addEventListener("mousedown", (e) => {
    const li = e.target.closest(".combo__item");
    if (!li) return;
    e.preventDefault(); // select before the input's blur hides the list
    chooseCarOption(li);
  });

  // Arrow/Enter/Escape on the input itself. Nothing here touches aria-expanded:
  // it opens by calling renderCarResults and closes by calling hideCarResults,
  // which are still the only two writers of it.
  $("carSearch").addEventListener("keydown", (e) => {
    const closed = $("carResults").hidden;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); // otherwise the caret jumps to one end of the text
      if (closed) renderCarResults(pickerOpenQuery(e.target.value));
      setCarActive(nextOptionIndex(carActiveIndex, carOptionEls().length, e.key));
    } else if (e.key === "Enter") {
      const action = enterAction(!closed, carActiveIndex);
      if (action === "ignore") return;
      e.preventDefault();
      // Nothing active means a soft keyboard, which sends no arrow keys at all.
      // Dismissing the list is the least this key can do and still mean something.
      if (action === "close") hideCarResults();
      else chooseCarOption(carOptionEls()[carActiveIndex], { keepFocus: true });
    } else if (e.key === "Escape") {
      if (closed) return;
      e.preventDefault();
      // Escape cancels the search, so put back the text the box opened with.
      e.target.value = carRestoreValue;
      hideCarResults();
    }
    // Home and End are left alone on purpose: this is an editable combobox, so
    // they belong to the caret in the text field, not to the list.
  });

  // The name field writes through writeCarName, which saves, repaints the two
  // things that read a car's name, and says so when the disk refused. It never
  // assigns $("carNickname").value: the user owns that field while they are
  // typing in it. writeDisplayValues is the one unconditional writer of it;
  // repaintCarName is the other, and skips the field entirely while it has
  // focus.
  $("carNickname").addEventListener("input", (e) => {
    writeCarName(e.target.value);
  });

  // Not on input: a field that refilled under the caret could not be cleared.
  $("carNickname").addEventListener("blur", settleCarName);

  // Enter does not blur a bare text input, so it commits in place instead of leaving the name empty.
  $("carNickname").addEventListener("keydown", (e) => {
    // Mid-composition an Enter belongs to the IME, and overwriting the field would take the candidate with it.
    if (e.key !== "Enter" || e.isComposing) return;
    settleCarName();
    // The field is skipped by the repaint while it has focus, which is the whole reason Enter has to fill it.
    $("carNickname").value = carNameForField();
  });

  // --- Adding a car ---------------------------------------------------------
  //
  // The ONE gesture that grows the list. Picking from the typeahead shows a
  // car; this is what puts one in your cars, which is why the label reads "Add
  // this car" and never "Save": the numbers were already saved as they were
  // typed, and a save button beside them would say otherwise.
  $("addCarBtn").addEventListener("click", addCurrentCar);

  // --- Removing a car -------------------------------------------------------
  //
  // The control opens the question; the dialog's own close is what answers it.
  // Routing the act through `close` rather than through the Remove button's
  // click is what makes Escape and "Keep it" one path instead of two.
  $("removeCarBtn").addEventListener("click", askRemoveCar);

  $("removeCarDialog").addEventListener("close", (e) => {
    if (e.target.returnValue !== "remove") return;
    removeActiveCar();
  });

  // --- The chip row ---------------------------------------------------------
  //
  // Delegated, because renderMyCars replaces every chip on each repaint and a
  // listener bound to a button would go with it.
  $("myCarsRow").addEventListener("click", (e) => {
    const chip = e.target.closest(".my-cars__chip");
    if (!chip) return;
    // The picker closes here rather than being left to the deferred blur. The
    // switch rewrites the field a line below, so a list still showing hits for
    // the old query is a list that no longer answers to what the field says,
    // and the blur close is not a close this gesture can rely on: a chip that
    // takes no focus never fires one, and the list then stays open for good.
    //
    // Closing AFTER the switch is what banks the right Escape value, since
    // hideCarResults samples the field on its way out and the field is not
    // settled until the switch has written to it.
    clearTimeout(carBlurTimer); // the blur this click caused; its close is now redundant
    // Counted at the two call sites a USER reaches, not inside switchToMyCar:
    // removeActiveCar calls that function itself to land on the neighbouring
    // car, and counting there would report a switch on every removal.
    trackWhenReady("cars-switched");
    switchToMyCar(chip.dataset.myCarId);
    hideCarResults();
  });

  // Arrows MOVE AND SELECT, which is the radiogroup default and the right
  // behavior here: there are at most five cars, the switch is instant and fully
  // visible, and a two-step "arrow to it, then press Space" would make the
  // keyboard path slower than the tap it mirrors. Home and End jump to the
  // ends, which the combobox next to it deliberately does not do, because there
  // the two keys belong to the caret in the text field.
  $("myCarsRow").addEventListener("keydown", (e) => {
    const chips = myCarChipEls();
    const at = chips.indexOf(document.activeElement);
    if (at < 0) return; // a key that arrived on the container, not on a chip
    const next = nextChipIndex(at, chips.length, e.key);
    if (next === at || next < 0) return;
    e.preventDefault(); // Left/Right would otherwise scroll the page sideways
    trackWhenReady("cars-switched"); // the keyboard half of the chip click above
    switchToMyCar(chips[next].dataset.myCarId);
    // The row was rebuilt by the switch, so the element just focused is gone.
    // Re-find by position: list order is stable across a repaint, only the
    // nodes are new.
    myCarChipEls()[next]?.focus();
  });

  // --- Two tabs -------------------------------------------------------------
  //
  // Both triggers run the same read, for two different failure modes.
  //
  // `storage` is the live one and fires only at the OTHER tabs, which is what
  // keeps this off the write path. A null key means the whole store was
  // cleared, so it is ours too.
  //
  // ONLY the cars key. sicc.prefs.v1 is written by render(), which is every
  // keystroke, and render() is also what a prefs refresh would have to call to
  // be worth anything: that is a write answering a write, in both directions,
  // forever. Prefs also holds the CHARGER the user is standing at, and pulling
  // another tab's rate and fees into this one is the rug-pull switchToMyCar
  // exists to avoid.
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== CARS_KEY) return;
    refreshMyCarsFromStore();
  });

  // And the backstop, because a background tab can be frozen with its `storage`
  // events dropped, and because people switch between tabs rather than watching
  // two at once. Its own listener rather than a clause inside the theme one: a
  // handler named for re-resolving a theme is not where a car store belongs.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshMyCarsFromStore();
  });

  // track() dedupes per session, so this counts visits that reached out, not clicks.
  $("feedbackLink").addEventListener("click", () => {
    track("feedback-clicked");
    // Read the address off the href so it can never drift from what the link opens.
    const email = $("feedbackLink").href.replace(/^mailto:/, "").split("?")[0];
    const copied = navigator.clipboard?.writeText(email);
    if (!copied) return;
    copied.then(() => showCopyToast("Email address copied"), () => {});
  });

  $("resetBtn").addEventListener("click", () => {
    prefs = resetPrefs();
    // "Reset everything" means everything, saved cars included. Keeping them
    // would also keep the migration's one-shot flag burned, so the fresh prefs
    // would come up beside a list of cars they know nothing about, and the user
    // would be looking at a clean slate that is not clean underneath.
    //
    // No re-migration afterwards, and none is needed: prefs are at their
    // defaults now, so there is nothing to carry across and migrateIfNeeded
    // would write nothing. The empty state below is the same answer it reaches.
    clearMyCars();
    myCars = emptyCarsState();
    // Reset volatile UI too: pricing mode, schedule/tier rows, info note.
    rateMode = "flat";
    chargeCapMin = null;
    capTouched = false;
    const flatRadio = document.querySelector('input[name="rateMode"][value="flat"]');
    if (flatRadio) flatRadio.checked = true;
    $("touRows").innerHTML = "";
    $("durRows").innerHTML = "";
    $("timeFeeRows").innerHTML = "";
    $("taxRows").innerHTML = "";
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
  // The summary is carSummaryText's to write here as everywhere else. Spelling
  // out `${car.make} ${car.model}` in a branch below is what made a named car
  // come back from a reload under a name the user never gave it: boot is the
  // one moment a saved name has to survive, and it was the one writer that did
  // not ask. null wherever there is no dataset row, because a custom or
  // orphaned car HAS none, not because the lookup failed.
  //
  // WHICH branch is carTileSource's to decide, for the same reason the naming
  // is carSummaryLabel's: this used to be a dataset lookup and an else, so a
  // carId the dataset had dropped landed on the empty state with the user's own
  // record sitting right there holding its name.
  const car = prefs.carId && prefs.carId !== CUSTOM_CAR_ID ? getCar(prefs.carId) : null;
  const saved = activeSavedCar();
  const source = carTileSource(prefs.carId, car, saved);
  if (source === "custom") {
    $("carName").textContent = carSummaryText(saved, null);
    $("carSearch").value = "My own car";
    $("tweak").open = true;
  } else if (source === "dataset") {
    $("carName").textContent = carSummaryText(saved, car);
    $("carSearch").value = carLabel(car);
    $("tweak").open = false;
  } else if (source === "orphan") {
    // The dataset no longer lists this car; the store still holds the record,
    // and the numbers on screen are that record's. Painted the way a switch to
    // this same car paints it, because a reload is not a different event:
    // switchToMyCar's no-row branch is the one definition of what an orphan
    // looks like, and this reads the same two fields it does.
    //
    // The picker is NOT forced open the way the empty state forces it. That
    // nudge is for a user with no car, and this user has one.
    $("carName").textContent = carSummaryText(saved, null);
    $("carSearch").value = saved.label || "";
    $("tweak").open = false;
  } else {
    // Clean slate - nudge the user to pick a car. Not routed: there is no car
    // here to summarize, so this is a different sentence, not a fallback.
    $("carName").textContent = "Select your car";
    $("carSearch").value = "";
    $("carTile").open = true;
    $("tweak").open = false;
  }
  // The record wins over prefs here: the prefs mirror holds one slot per MODEL.
  if (saved) prefs = { ...prefs, ...savedCarNumbers(saved, getCar) };
  writeDisplayValues();
  renderMyCars();
  applyRateMode();
  render();
}

// --- PWA update watch -------------------------------------------------------
// Detect when a newer deploy is live and offer a non-disruptive "refresh"
// toast. We never reload on our own - the user taps Refresh when they're ready,
// so an update can never interrupt them mid-calculation.
//
// How we know a new version shipped:
//   1. version.json - stamped with the commit SHA by the deploy workflow. This
//      catches EVERY change (including internal JS that never appears in
//      index.html) with a single tiny request per check.
//   2. Fallback (no CI yet): fingerprint the core assets by hashing their
//      contents, so an internal-only change is still caught. Costs a few small
//      requests, so it's only used when version.json is absent.
//
// Every request appends ?__vcheck=1 so the service worker passes it straight to
// the network (see service-worker.js) - never cached, never stale.
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000; // re-check every 15 min while open
// EVERY module main.js reaches belongs here, or a release that only touched the
// missing one raises no toast. test/assets.test.mjs pins this list.
const UPDATE_FINGERPRINT_ASSETS = [
  "./index.html", "./css/styles.css",
  "./js/main.js", "./js/calc.js", "./js/units.js", "./js/storage.js",
  "./js/cars.js", "./js/myCars.js", "./js/myCarsUi.js", "./js/ui.js",
  "./js/theme.js", "./js/analytics.js", "./js/editorRows.js", "./js/dropdown.js",
  "./data/phevs.json",
];

function hashText(text) {
  // djb2 - a compact, dependency-free fingerprint. Not cryptographic; we only
  // need "did the bytes change", not security.
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function fetchVersionSignature() {
  // Prefer the CI-stamped commit SHA: one request, catches every change.
  try {
    const res = await fetch("./version.json?__vcheck=1", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.commit === "string" && data.commit && data.commit !== "dev") {
        return `v:${data.commit}`;
      }
    }
  } catch { /* fall through to the asset fingerprint */ }

  // Fallback: hash the core assets so internal-only changes still register.
  // If ANY asset can't be fetched (e.g. offline), we can't form a reliable
  // fingerprint, so return null and let the caller skip this round. (Never
  // hash partial/empty responses - that would fabricate a "new version".)
  try {
    const texts = await Promise.all(UPDATE_FINGERPRINT_ASSETS.map((u) =>
      fetch(`${u}?__vcheck=1`, { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error("asset unavailable");
        return r.text();
      })
    ));
    return `h:${hashText(texts.join("\u0000"))}`;
  } catch {
    return null;
  }
}

function setupUpdateWatch() {
  let baseline = null;      // signature of the build this tab is running
  let toastVisible = false; // a refresh toast is currently on screen
  let dismissed = false;    // user dismissed - stay quiet for the rest of the session
  let lastCheck = 0;

  function showUpdateToast() {
    if (toastVisible) return;
    toastVisible = true;

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");

    const text = document.createElement("span");
    text.className = "toast__text";
    text.textContent = "A new version is available.";

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "toast__action";
    refresh.textContent = "Refresh";
    refresh.addEventListener("click", () => window.location.reload());

    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast__dismiss";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "\u2715";
    close.addEventListener("click", () => {
      dismissed = true;
      toastVisible = false;
      toast.remove();
    });

    toast.append(text, refresh, close);
    document.body.appendChild(toast);
  }

  async function check() {
    // Never stack toasts or nag: at most one toast until the user acts, and
    // once dismissed we stay quiet. This is what keeps 20 pushes in a day from
    // becoming 20 toasts - the tab shows one, then it's silent until refreshed.
    if (dismissed || toastVisible) return;
    if (navigator.onLine === false) return; // offline: nothing to check, try again later
    const now = Date.now();
    if (now - lastCheck < 60 * 1000) return; // debounce focus/interval bursts
    lastCheck = now;

    const sig = await fetchVersionSignature();
    if (!sig) return; // no reliable answer (e.g. dropped offline mid-check) - skip, keep baseline
    if (baseline === null) { baseline = sig; return; } // first read = the build we booted with
    if (sig !== baseline) showUpdateToast();           // anything newer -> offer refresh
  }

  check(); // establish the baseline for this session
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check(); // catch updates on resume
  });
}

async function init() {
  await loadCars();
  initMyCars(); // after loadCars: the migration snapshots labels and ceilings from it
  attachEvents();
  boot();

  // PWA signals. "standalone" = launched from an installed copy (fires on every
  // such session); "installed" = the one-time install event (not fired by iOS
  // Safari, which has no appinstalled event - those show up as standalone).
  if (window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone) {
    trackWhenReady("pwa-standalone");
  }
  window.addEventListener("appinstalled", () => trackWhenReady("pwa-installed"));

  if ("serviceWorker" in navigator) {
    const isLocal = ["localhost", "127.0.0.1", "[::1]", ""].includes(location.hostname);
    if (isLocal) {
      // Local dev: don't let a cached service worker hide file changes. Tear
      // down any existing registration + caches so every reload is fresh.
      navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
      if (self.caches) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
    } else {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {});
      setupUpdateWatch();
    }
  }
}

init();
