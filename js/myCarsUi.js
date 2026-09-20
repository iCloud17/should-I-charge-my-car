// myCarsUi.js - the pure rules behind the saved-cars UI: which chrome is
// visible, what a chip is called, and where a keystroke moves the selection.
//
// Split out of main.js for the reason everything else in this project is split
// out: a rule a test cannot import is a rule nothing holds. Every function here
// takes values and returns values, touches no DOM and no storage, and is
// exercised in test/myCarsUi.test.mjs.
//
// It READS the store's vocabulary and never writes. myCars.js owns what a saved
// car is; this file owns what a car is CALLED, which is a stored value rather
// than a painted one, so the default a record is created with lives here beside
// the rules that read it back.

import { CUSTOM_CAR_ID } from "./myCars.js";
import { clipWholeCharacters } from "./storage.js";

// The dataset row behind a saved car, or null. A local copy of the lookup
// myCars.js keeps private, and deliberately not an export of that file: this
// one also answers null for the custom sentinel, because a custom car has no
// row and asking for one is how a caller ends up with "undefined undefined".
//
// Never throws. The dataset is fetched at startup and may not have arrived, and
// a lookup that fails must cost the label rather than the chip.
function rowFor(getCar, carId) {
  if (typeof getCar !== "function" || !carId || carId === CUSTOM_CAR_ID) return null;
  try {
    const row = getCar(carId);
    return row && typeof row === "object" ? row : null;
  } catch {
    return null;
  }
}

function trimmed(v) {
  return typeof v === "string" ? v.trim() : "";
}

// --- The disclosure rule ----------------------------------------------------

// The multi-car threshold. Since the chip row and the remove control moved down
// to one saved car, this gates exactly one thing: whether the COUNT alone earns
// a name field, which a lone car has nothing to tell itself apart from.
// showsNameField's other clauses still answer for a car that already has a name.
export function showsCarChrome(count) {
  return Number.isInteger(count) && count >= 2;
}

// Whether the control that puts the car on screen into the list is visible.
// Both terms carry weight.
//
// `live` is the STORE. initMyCars leaves it false when the dataset has not
// arrived, so the one-shot migration is not spent on cars with no label and no
// onboard maximum. With a dead store, "is this car in the list" answers false
// for every car, so dropping this term would leave the control permanently on
// screen doing nothing on every tap, which is the silent refusal this control
// exists to end.
//
// `hasCar` is the SCREEN. There has to be a car to add, and a first run has
// none.
//
// There is deliberately no cap term. At the limit the control stays visible and
// answers with atCapMessage, because a control that vanishes at the limit turns
// a limit into a dead end with nothing to read.
export function showsAddControl(live, hasCar) {
  return Boolean(live) && Boolean(hasCar);
}

// What that control says. It never says "save": these numbers are already
// saved, on every keystroke, and a save button sitting next to them would teach
// the user that what they typed is uncommitted until they press it. This is
// list membership, and it pairs with "Remove this car".
//
// "Add a copy" is the route to two records of one model, which is the case the
// feature was asked for: two of the same car, driven differently.
export function addControlLabel(isSaved) {
  return isSaved ? "Add a copy" : "Add this car";
}

// What a NEW record is called. A copy gets the name nextCopyName built for it;
// a first add gets whatever the legacy name slot already holds, which describes
// the custom car and no other; anything else gets the default. The last term is
// what makes "a record is never created nameless" true at the one place records
// are created.
export function newCarName(copyName, typedName, defaultName) {
  return trimmed(copyName) || trimmed(typedName) || trimmed(defaultName);
}

// The row is on screen from the FIRST saved car, and takes no view of what is
// selected: adding a car has to visibly produce a chip, or the only save this
// app offers reports itself by changing the label on the button that did it.
export function showsChipRow(count) {
  return Number.isInteger(count) && count >= 1;
}

// When the remove link is on screen. Never with nothing selected: removeActiveCar
// early-returns on a null active record, so an unselected screen would be
// offering a control that cannot do anything.
export function showsRemoveLink(count, isSaved) {
  return Number.isInteger(count) && count >= 1 && Boolean(isSaved);
}

// When the ROW holding those two controls is on screen, which is a different
// question from whether either control is, and the one the picker answers.
//
// The results list is absolutely positioned onto exactly this row's space, so
// under an open list a tap meant for "Add this car" hits the car row painted
// over it. Hidden rather than disabled, which also takes it out of the tab
// order.
//
// This answers for the ROW only. The controls' own hidden flags stay
// renderMyCars's, so each flag has exactly one writer.
export function showsCarListActions(listOpen) {
  return !listOpen;
}

// The query a fresh open searches from: the custom car's label matches no car.
export function pickerOpenQuery(fieldValue) {
  return fieldValue === "My own car" ? "" : fieldValue;
}

// Who gets a name field. Following the NAME as well as the count is what keeps
// naming reversible: a car named at two cars can still be renamed or cleared
// after the list shrinks back to one.
//
// The custom car has its own clause because its numbers are the user's to type,
// so the label for them is theirs too, and it starts with no name.
//
// The chrome clause is gated on SAVED because saveCarName finds no record for
// an unsaved car and drops every keystroke, and a field that writes nowhere
// takes a name the user meant to keep.
export function showsNameField(count, isCustom, hasName, isSaved) {
  return (showsCarChrome(count) && Boolean(isSaved)) || Boolean(isCustom) || Boolean(hasName);
}

// --- What a car is called ---------------------------------------------------

// The name a car is given when the user has not chosen one. STORED, on the
// record, rather than worked out at paint time: every reader then asks one
// question and gets one answer, and nothing on screen can move because a
// different car was renamed.
//
// MAKE PLUS MODEL, and the year is left out deliberately. The search box sits
// directly under the heading already reading "2024 Toyota Prius Prime", so
// including it would make the two largest pieces of text in the tile identical.
//
// An orphan has no row to take a make and model from, so its stored label is
// all there is. The leading year is stripped off it for the same reason, and
// stripping that is safe where splitting make from model is not: carLabel
// writes "year make model", so a leading four-digit group is the app's own
// prefix rather than a guess about where a make ends.
export function defaultCarName(saved, getCar) {
  if (saved?.carId === CUSTOM_CAR_ID) return "My own car";
  const row = rowFor(getCar, saved?.carId);
  const fromRow = trimmed(`${trimmed(row?.make)} ${trimmed(row?.model)}`);
  if (fromRow) return fromRow;
  return trimmed(saved?.label).replace(/^\d{4}\s+/, "") || "Car";
}

// The same list with a name on every car, which is how a payload arrives in
// memory. The fill happens on the READ and never writes: a page load that wrote
// would fire a storage event at every other tab, and two tabs answering each
// other's writes never stop. The name reaches disk with the next real write.
//
// An existing user's records carry `name: ""`, so this is also the whole of the
// backfill: there is no second case left for anything downstream to reason
// about.
export function withDefaultNames(cars, getCar) {
  const list = Array.isArray(cars) ? cars : [];
  return list.map((c) => (trimmed(c?.name) ? c : { ...c, name: defaultCarName(c, getCar) }));
}

// --- What a chip is called --------------------------------------------------

// What a chip says, which is the car's name and nothing computed. The fallback
// is for a record caught without one: a name being retyped, or a record that
// reached the row without going through the read path.
export function chipBaseLabel(saved, getCar) {
  return trimmed(saved?.name) || defaultCarName(saved, getCar);
}

// The full year-make-model, for the accessible name and the remove confirm.
// Empty when the car is custom or orphaned and carries no label, which both
// callers handle rather than papering over with a placeholder.
export function chipFullName(saved, getCar) {
  const row = rowFor(getCar, saved?.carId);
  if (row) return `${row.year} ${row.make} ${row.model}`;
  return trimmed(saved?.label);
}

// The chip's accessible name: what it says, then the full year-make-model.
//
// The visible text is a PREFIX rather than being replaced by the fuller string,
// which is WCAG 2.5.3 Label in Name. A voice-control user says the words they
// can see, so a car called "Prius Prime 2" has to appear in the name or "tap
// Prius Prime 2" matches nothing.
export function chipAccessibleName(visible, full) {
  const v = trimmed(visible);
  const f = trimmed(full);
  if (!f || f === v) return v;
  return `${v}, ${f}`;
}

// Everything the chip row needs, in list order: the id to switch to, the text
// to paint, and the name to announce. The text is the record's own name and
// nothing computed, so no chip can move because a different car was renamed.
export function buildChips(cars, getCar) {
  const list = Array.isArray(cars) ? cars : [];
  return list.map((c) => {
    const label = chipBaseLabel(c, getCar);
    return { id: c.id, label, accessibleName: chipAccessibleName(label, chipFullName(c, getCar)) };
  });
}

// WHICH chip reads as checked, and the store's own activeId is not the answer.
//
// It takes the record the MISMATCH GUARD already answered with, which is the
// same record the car tile is painted from. The two stores can point at
// different cars: an older build writes prefs.carId and knows nothing about
// this one, so a rollback and roll-forward leaves sicc.cars.v1 selecting a car
// prefs has moved off. The tile handles that already (it falls back to the
// prefs path, and the remove control hides), but the row went on reading
// activeId raw and checked a chip for a car that was not on screen. To a screen
// reader that is a flat contradiction with the heading beside it.
//
// Nothing selected is a state this row can hold: renderMyCars parks the tab
// stop on the first chip and leaves every one of them unchecked.
export function checkedChipId(saved) {
  return saved?.id ?? null;
}

// What the chip for ONE record says. Routed through buildChips so a sentence
// about a car uses the words the row beside it is already using.
export function chipLabelFor(cars, id, getCar) {
  return buildChips(cars, getCar).find((c) => c.id === id)?.label ?? "";
}

// --- What a copy is called --------------------------------------------------

// The words a copy's name is built from: what the source car is CALLED, less
// the number an earlier copy put on the end.
//
// The number is only stripped when what is left is this car's own default name,
// which is what keeps chained copies in one family ("Car 3", not "Car 2 2")
// without reading a typed "Model 3" as a numbered "Model".
export function copyBaseName(saved, getCar) {
  const plain = defaultCarName(saved, getCar);
  const name = trimmed(saved?.name);
  if (!name) return plain;
  const numbered = name.match(/^(.+?)\s+\d+$/);
  return numbered && numbered[1] === plain ? plain : name;
}

// Every string a new name could collide with, which is what the chips READ.
export function takenCarNames(cars, getCar) {
  return new Set(buildChips(cars, getCar).map((c) => c.label));
}

// The base plus the smallest free number from 2 up.
//
// Reusing a number a removal freed is correct: that is a new car taking a free
// name, not a car the user already knows being renamed behind them.
//
// THE BASE IS WHAT GETS CLIPPED at the cap, never the number. A name ending in
// half a number tells two cars apart worse than a clipped base does.
export function nextCopyName(base, taken, max) {
  const b = trimmed(base);
  if (!b) return "";
  const used = new Set(taken || []);
  const cap = Number.isInteger(max) && max > 0 ? max : 0;
  let n = 1;
  let name = "";
  // Terminates: distinct numbers give distinct names, and `used` is finite.
  do {
    n += 1;
    const tail = ` ${n}`;
    name = `${cap ? clipWholeCharacters(b, cap - tail.length).trimEnd() : b}${tail}`;
  } while (used.has(name));
  return name;
}

// --- What the car tile says -------------------------------------------------

// What the LEGACY name slot answers. prefs.customName is one slot and it has
// only ever described the custom car: migrateCars carries it into that car's
// name and into no other, so it answers for that car and answers empty for
// every other. Every reader of the slot goes through here, so the rule has one
// definition instead of a comparison repeated at each of them.
export function legacyNameSlot(isCustom, customName) {
  return isCustom ? trimmed(customName) : "";
}

// What the name field shows. The record owns a car's name at every car count,
// and the slot is the fallback for the one car that still has no record to ask:
// a dead store, or the mismatch guard refusing to answer.
//
// EMPTY IS THE RIGHT ANSWER for a nameless saved car, and the defect this
// replaces is what it looks like when it is not. The field fell through to the
// slot for ANY unnamed car, so a Prius Prime added after a custom car called
// "Van" opened its panel reading "Van" beside a heading that said Toyota, and
// one keystroke renamed the PRIUS to "Vane" for good. In a feature whose whole
// point is telling near-identical cars apart, the field was defaulting to
// another car's name and then writing it down.
//
// It carries NO disambiguating suffix, unlike the heading. This is an editable
// value on its way to renameMyCar, so a computed "2" shown here is a "2" the
// next keystroke saves as part of the real name.
export function nameFieldValue(saved, isCustom, customName) {
  return trimmed(saved?.name) || legacyNameSlot(isCustom, customName);
}

// WHICH car the tile is looking at, which is a different question from what to
// call it and the one boot() got wrong.
//
// carSummaryLabel below answers the naming question and answers it correctly
// for an orphan: no row, so the stored label. What it cannot answer is whether
// there is a car here at all, so the caller decides that first, and boot
// decided it by asking the DATASET alone. A carId the dataset no longer lists
// came out as the empty state, and a user was told to pick a car while that
// car's own numbers sat in the fields beside the sentence.
//
// The RECORD is the other half of the answer, and the half that makes the label
// snapshot worth taking. A reseed dropping a carId is the case that snapshot
// exists for, so a record still pointing at the missing car is a car, not an
// absence. "none" is kept for the two states that really are empty: no carId at
// all, and a carId with no record behind it - a first run, a dead store, or the
// mismatch guard refusing to answer. Those fall back to prefs, which is the
// path that shipped before this feature.
//
// The custom sentinel is answered before the row lookup because a custom car
// HAS no row, and asking for one is how it would be mistaken for an orphan.
export function carTileSource(carId, car, saved) {
  if (!carId) return "none";
  if (carId === CUSTOM_CAR_ID) return "custom";
  if (car) return "dataset";
  return saved ? "orphan" : "none";
}

// The car tile's collapsed summary. The record's name wins, and after the read
// path fills one in that is every saved car; the arms below answer for the
// states that hold no record at all, and for the moment between clearing a name
// and leaving the field.
//
// `fallbackName` is legacyNameSlot's answer, handed in rather than read, which
// is the only reason this rule can live in this file at all. It is the LAST
// thing consulted, so every no-record case a caller can reach - a dead store,
// the mismatch guard refusing to answer, a car the cap would not take - still
// comes out as `customName || "My car"` for the CUSTOM car, the exact
// expression that shipped. For any other car the slot is empty, so an orphan
// carrying no stored label falls to "My car" and not to the custom car's name.
//
// `car` is the dataset row or null, and the caller decides which. A custom car
// passes null because it HAS no row, not because the lookup failed.
export function carSummaryLabel(saved, car, fallbackName) {
  const name = trimmed(saved?.name);
  if (name) return name;
  if (car) return `${car.make} ${car.model}`;
  return saved?.label || fallbackName || "My car";
}

// --- Keyboard ---------------------------------------------------------------

// Where a key moves the selection in the chip row.
//
// A separate function from ui.js's nextOptionIndex rather than a fourth branch
// inside it, because the two widgets answer different questions. That one
// drives an editable combobox, where Home and End belong to the caret in the
// text field and are deliberately left alone. A radiogroup holds no text, so
// Home and End are the group's to take, and the row is horizontal, so Left and
// Right are its primary keys.
//
// Both axes move. A chip row wraps on a narrow screen, so a user looking at a
// second line will press Down to reach it, and a radiogroup that ignored Down
// would strand them.
//
// An out-of-range `current` resolves to 0 rather than to -1, which is the other
// difference from nextOptionIndex. A radiogroup always has a selection, so
// there is no "nothing active yet" state to represent.
export function nextChipIndex(current, count, key) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  const at = Number.isInteger(current) && current >= 0 && current < count ? current : 0;
  if (key === "ArrowRight" || key === "ArrowDown") return at === count - 1 ? 0 : at + 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return at === 0 ? count - 1 : at - 1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return at;
}

// --- Copy -------------------------------------------------------------------

// What the user is told when the add link is tapped at the cap.
//
// The store refuses at the cap rather than evicting the oldest car, so this
// sentence is the whole of what the user gets, and it has to name both the
// limit and the way out. "You can't" with no next step reads as a bug report.
//
// The number comes from the caller, which passes the same MAX_MY_CARS the store
// enforces, so the figure in the sentence cannot drift from the figure in the
// rule.
export function atCapMessage(limit) {
  return `You can save up to ${limit} cars. Remove one first to add another.`;
}

// What the user is told when the store refuses an add. TOTAL over addMyCar's
// reasons, and that totality is the rule rather than a nicety: the cap was the
// only reason anything ever handled, so a car the store narrowed away was added
// to nothing and reported as nothing, which is the defect shape this whole
// control exists to remove.
//
// The cap gets its own sentence because it has a way out to name. Every other
// refusal is one car the store would not take, the user did nothing wrong, and
// the honest thing is to say so and stop.
export function addRefusalMessage(reason, limit) {
  if (reason === "full") return atCapMessage(limit);
  return "That car could not be added. Try picking it again.";
}

// What the user is told when the store took the car and the WRITE would not.
// The caller discards the new state rather than keeping it in memory, so this
// reports the outcome that actually happened: no new car in the list.
//
// It says "added", not "saved", for the same reason the control does. The
// numbers in the fields were written as they were typed, and are not what is at
// risk here; a save vocabulary would say they were, at the one moment the user
// is already being told something went wrong.
export function addWriteFailedMessage(reason) {
  return `That car was not added. ${writeRefusalCause(reason)}`;
}

// The add announcement, the same shape removeActiveCar uses for "Removed X.".
// The note is a live region and is the whole of what a screen reader hears for
// either act, so the two have to arrive as a matched pair.
export function addedMessage(label) {
  const l = trimmed(label);
  return l ? `Added ${l}.` : "Added this car.";
}

// The removal announcement, addedMessage's pair. Past tense and terminal
// because the question was asked and answered before the act: there is nothing
// left to decide by the time this is read.
export function removedMessage(label) {
  const l = trimmed(label);
  return l ? `Removed ${l}.` : "Removed this car.";
}

// What the user is told when the store took the removal and the WRITE would
// not. addWriteFailedMessage's pair: the outcome differs by one word and the
// cause is the same sentence, because one condition told two ways reads as two
// different problems.
//
// It is the more important of the pair. A refused add leaves the user with one
// car fewer than they wanted and they can see that. A refused removal announced
// as a success is a claim that data was deleted when it is still on disk, and
// on a shared device that claim is the whole of what the user is going on.
export function removeWriteFailedMessage(reason) {
  return `That car was not removed. ${writeRefusalCause(reason)}`;
}

// The rename's pair. The chip and the heading used to show a name the disk had refused.
export function nameWriteFailedMessage(reason) {
  return `That name was not saved. ${writeRefusalCause(reason)}`;
}

// "to this car" because the legacy per-model override did take them; the record is what missed out.
export function numbersWriteFailedMessage(reason) {
  return `Those numbers were not saved to this car. ${writeRefusalCause(reason)}`;
}

// WHY the store would not write, which saveMyCars reports and the two messages
// above share. TOTAL over its reasons, the way addRefusalMessage is: an unknown
// reason falls to the blocked-storage sentence, which is the one that names
// something the user can go and look at.
//
// The two cases are not one condition, and the unread version of this said they
// were. A newer build's payload on disk is THIS build being out of date, and it
// comes right on a reload; sending that user to their privacy settings is an
// instruction that cannot work, for a problem they do not have.
function writeRefusalCause(reason) {
  if (reason === "read-only") return "Reload to catch up with a newer version of this app.";
  return "This browser may be blocking site data.";
}

// What the user is asked before a car goes. Fed from chipLabelFor and never
// from the full year-make-model: two records of one model share that string, so
// the question would name a car that is still on screen and still checked.
export function removeConfirmQuestion(label) {
  const l = trimmed(label);
  return l ? `Remove ${l}?` : "Remove this car?";
}

// What the user is told when the question they were answering stopped being
// about a car that exists, because another tab removed it while the modal was
// open.
//
// The question is CLOSED rather than re-pointed at whatever is selected now.
// The user answered about one car, and an answer given about one car must not
// be spent on another. Past tense and terminal, like removedMessage: the
// outcome the question was asking for has already happened.
export function removeGoneMessage(label) {
  const l = trimmed(label);
  return l ? `${l} was already removed in another tab.` : "That car was already removed in another tab.";
}
