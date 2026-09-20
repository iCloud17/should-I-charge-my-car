import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  showsCarChrome, showsNameField,
  showsAddControl, addControlLabel, showsChipRow, showsRemoveLink, showsCarListActions, pickerOpenQuery, newCarName,
  defaultCarName, withDefaultNames,
  chipBaseLabel, chipFullName, chipAccessibleName, buildChips,
  chipLabelFor, checkedChipId,
  copyBaseName, takenCarNames, nextCopyName,
  carTileSource, carSummaryLabel, legacyNameSlot, nameFieldValue,
  nextChipIndex, atCapMessage, addRefusalMessage, addWriteFailedMessage, addedMessage,
  removedMessage, removeWriteFailedMessage, removeConfirmQuestion, removeGoneMessage,
  nameWriteFailedMessage, numbersWriteFailedMessage,
} from "../js/myCarsUi.js";
import { CUSTOM_CAR_ID, MAX_MY_CARS, addMyCar, emptyCarsState } from "../js/myCars.js";
import { MAX_CUSTOM_NAME_LEN } from "../js/storage.js";

// A stand-in dataset. Keyed lookup so a carId that is not here answers
// undefined, which is the orphaned-car case the label rules have to survive.
const ROWS = {
  rav4: { id: "rav4", year: 2024, make: "Toyota", model: "RAV4 Prime" },
  prius23: { id: "prius23", year: 2023, make: "Toyota", model: "Prius Prime" },
  prius21: { id: "prius21", year: 2021, make: "Toyota", model: "Prius Prime" },
  rover: { id: "rover", year: 2016, make: "Land Rover", model: "Range Rover" },
  // The longest make plus model in the bundled dataset, at 56 characters.
  amgE53: {
    id: "amgE53",
    year: 2026,
    make: "Mercedes-Benz",
    model: "AMG E53 Hybrid 4matic Plus (station wagon)",
  },
};
const getCar = (id) => ROWS[id];

// --- The disclosure rule ----------------------------------------------------

test("the count alone earns a name field only at two cars", () => {
  assert.equal(showsCarChrome(0), false);
  assert.equal(showsCarChrome(1), false);
  assert.equal(showsCarChrome(2), true);
  assert.equal(showsCarChrome(5), true);
});

test("the chrome un-discloses: deleting back down to one car hides it again", () => {
  // Same function, read in the shrinking direction. A user who tries naming and
  // changes their mind gets their old screen back.
  assert.equal(showsCarChrome(3), true);
  assert.equal(showsCarChrome(2), true);
  assert.equal(showsCarChrome(1), false);
});

test("showsCarChrome refuses a non-integer rather than coercing it", () => {
  assert.equal(showsCarChrome(undefined), false);
  assert.equal(showsCarChrome(null), false);
  assert.equal(showsCarChrome("2"), false);
  assert.equal(showsCarChrome(2.5), false);
});

test("a named car keeps its name field when the list shrinks back to one", () => {
  // The blocker this rule was written for. A car named at two cars used to lose
  // the field on the way down, keep the name, and go on announcing it from the
  // car tile with nothing on screen able to change it.
  assert.equal(showsNameField(1, false, true, true), true);
  assert.equal(showsNameField(1, false, false, true), false, "a nameless car at one car gets the screen that shipped");
});

test("the custom car keeps its field at one car, named or not", () => {
  // It has always had this field and it starts with no name, so the name clause
  // cannot be what carries it.
  assert.equal(showsNameField(1, true, false, true), true);
  assert.equal(showsNameField(0, true, false, false), true);
});

test("the chrome still brings the field with it at two cars", () => {
  assert.equal(showsNameField(2, false, false, true), true);
  assert.equal(showsNameField(5, false, false, true), true);
});

test("an unsaved car gets no name field, because there is nothing to write it to", () => {
  // saveCarName finds no record, so renameMyCar never runs and the customName
  // write is skipped for anything that is not the custom car. The field would
  // take a name the user meant to keep and drop every keystroke of it.
  assert.equal(showsNameField(2, false, false, false), false);
  assert.equal(showsNameField(5, false, false, false), false);
  assert.equal(showsNameField(2, true, false, false), true, "the custom car still writes to customName");
});

test("a first-run screen has no name field: nothing named, nothing custom", () => {
  assert.equal(showsNameField(0, false, false, false), false);
});

test("showsNameField reads the name as a fact, not as a string to parse", () => {
  // The caller trims and decides. This takes the answer, so a record whose name
  // is whitespace cannot sneak the field open behind carSummaryLabel's back.
  assert.equal(showsNameField(1, false, "", true), false);
  assert.equal(showsNameField(1, false, undefined, true), false);
  assert.equal(showsNameField("2", false, false, true), false, "a non-integer count is still not chrome");
});

// --- The add control --------------------------------------------------------

test("the add control needs a live store, not just a car on screen", () => {
  // A dead store answers "not in the list" for every car, so without the live
  // term this control would sit there permanently and do nothing on every tap,
  // which is the exact silent refusal it exists to end.
  assert.equal(showsAddControl(false, true), false);
  assert.equal(showsAddControl(true, true), true);
});

test("the add control needs a car on screen, so a first run does not get one", () => {
  assert.equal(showsAddControl(true, false), false);
  assert.equal(showsAddControl(false, false), false);
});

test("the add control does NOT vanish at the cap", () => {
  // It takes no count at all, which is the point: at five cars it stays on
  // screen and answers with atCapMessage. A control that disappears at the
  // limit turns a limit into a dead end with nothing to read.
  assert.equal(showsAddControl(true, true), true);
});

test("the control names list membership, and never says save", () => {
  // These numbers are already saved on every keystroke. A save button beside
  // them would teach the user that what they typed is uncommitted until they
  // press it, which is false.
  assert.equal(addControlLabel(false), "Add this car");
  assert.equal(addControlLabel(true), "Add a copy");
  for (const s of [addControlLabel(true), addControlLabel(false)]) {
    assert.doesNotMatch(s, /sav/i, `the control offers to save something: ${s}`);
  }
});

test("a copy is named for the car it came from, plus the next free number", () => {
  // The reversal of 4ceb896. A copy used to start nameless so it could not
  // inherit the original's name, which left its chip suffix computed from
  // POSITION: removing "Car 2" renamed "Car 3" to "Car 2" under the user.
  assert.equal(newCarName("Prius Prime 2", ""), "Prius Prime 2");
  assert.equal(newCarName("", "Van"), "Van", "a first add is the user naming THIS car");
  assert.equal(newCarName("My own car 2", "Van"), "My own car 2", "a copy is not the car it came from");
});

test("A RECORD IS NEVER CREATED NAMELESS", () => {
  // The default is the last term, so the one place records are created cannot
  // make one without a name. Everything downstream then has a single case.
  assert.equal(newCarName("", "", "Toyota RAV4 Prime"), "Toyota RAV4 Prime");
  assert.equal(newCarName("", "Van", "Toyota RAV4 Prime"), "Van", "the user's own word still wins");
  assert.equal(newCarName("Toyota RAV4 Prime 2", "Van", "Toyota RAV4 Prime"), "Toyota RAV4 Prime 2");
  assert.equal(newCarName("", "", "   "), "", "whitespace is not a default either");
});

test("newCarName is total over what prefs can hand it", () => {
  for (const junk of [undefined, null, 0, {}, []]) {
    assert.equal(newCarName("", junk), "", `${String(junk)} came back as a name`);
    assert.equal(newCarName(junk, junk), "");
    assert.equal(newCarName(junk, junk, junk), "");
  }
  assert.equal(newCarName("", "  Van  "), "Van");
  assert.equal(newCarName("", "", "  Toyota RAV4 Prime  "), "Toyota RAV4 Prime");
});

// --- The chip row and the remove link ---------------------------------------

test("the first saved car puts the row on screen, selected or not", () => {
  // Pressing "Add this car" has to produce something visible. It used to flip
  // the button's label and print a line, with the list it had just joined still
  // hidden, so the app's only save left no trace of what it had saved.
  assert.equal(showsChipRow(1), true);
  assert.equal(showsChipRow(1, true), true, "the row takes no view of the selection");
  assert.equal(showsChipRow(1, false), true);
});

test("the chip row stays on at two cars and up", () => {
  assert.equal(showsChipRow(2), true);
  assert.equal(showsChipRow(5), true);
});

test("an empty list has no row to show", () => {
  assert.equal(showsChipRow(0), false);
  assert.equal(showsChipRow("1"), false, "a non-integer count is not a car");
  assert.equal(showsChipRow(null), false);
});

test("the remove link is never offered with nothing selected", () => {
  // removeActiveCar early-returns on a null active record, so the control would
  // be dead on arrival.
  assert.equal(showsRemoveLink(1, false), false);
  assert.equal(showsRemoveLink(2, false), false);
  assert.equal(showsRemoveLink(5, false), false);
  assert.equal(showsRemoveLink(2, true), true);
});

test("the only saved car can still be removed", () => {
  // It arrived with the row: a chip the user cannot get rid of is a dead end,
  // and the confirm dialog stands between a mis-tap and the loss.
  assert.equal(showsRemoveLink(1, true), true);
  assert.equal(showsRemoveLink(0, true), false, "an empty list has no record to remove");
  assert.equal(showsRemoveLink("1", true), false, "a non-integer count is not a car");
});

test("the row holding both controls is gone while the picker is open", () => {
  // H-3. The results list is absolutely positioned over exactly this row, so a
  // tap where "Add this car" is drawn landed on the car row painted above it
  // and selected "My own car", throwing away the car the user had just picked.
  assert.equal(showsCarListActions(true), false);
  assert.equal(showsCarListActions(false), true);
});

test("the row rule answers for the ROW and knows nothing about either control", () => {
  // The point of the split. Whether there is a car to add and whether removing
  // is on offer stay showsAddControl's and showsRemoveLink's, and this takes no
  // count and no car, so it cannot become a second opinion about either.
  assert.equal(showsCarListActions.length, 1);
  assert.equal(showsCarListActions(false), showsCarListActions(0));
  assert.equal(showsCarListActions(true), showsCarListActions("open"));
});

test("opening the picker on the custom car's label searches for nothing", () => {
  // The field carries that label while the custom car is selected, and it is
  // the one value in it that is not a car anyone can search for: left alone it
  // opens onto "No match" over a list of 441 cars.
  assert.equal(pickerOpenQuery("My own car"), "");
  assert.equal(pickerOpenQuery("Prius"), "Prius");
  assert.equal(pickerOpenQuery(""), "");
  assert.equal(pickerOpenQuery("my own car"), "my own car", "a typed query is not the label");
});

// --- The default name a car is stored with ----------------------------------

test("a dataset car is named for its make and model, and not for its year", () => {
  // The search box directly under the heading already reads "2024 Toyota RAV4
  // Prime", so including the year would make the two largest pieces of text in
  // the tile identical.
  assert.equal(defaultCarName({ carId: "rav4" }, getCar), "Toyota RAV4 Prime");
  assert.equal(defaultCarName({ carId: "rover" }, getCar), "Land Rover Range Rover");
});

test("the custom car is called My own car", () => {
  assert.equal(defaultCarName({ carId: CUSTOM_CAR_ID }, getCar), "My own car");
  assert.equal(defaultCarName({ carId: CUSTOM_CAR_ID, label: "2024 Toyota RAV4 Prime" }, getCar), "My own car");
});

test("an orphan is named from its stored label, less the year the app wrote on it", () => {
  // THE ORPHAN DECISION. There is no row to take a make and model from, so the
  // label snapshot is all there is. Stripping a LEADING FOUR-DIGIT GROUP is
  // safe where splitting make from model is not: carLabel writes "year make
  // model", so that group is the app's own prefix and not a guess about where a
  // make ends. What is left has the same shape as every other default.
  assert.equal(
    defaultCarName({ carId: "gone", label: "2016 Land Rover Range Rover" }, getCar),
    "Land Rover Range Rover",
  );
  // Only at the front, and only four digits: a model that carries a number
  // keeps it.
  assert.equal(defaultCarName({ carId: "gone", label: "Polestar 2" }, getCar), "Polestar 2");
  assert.equal(defaultCarName({ carId: "gone", label: "2021 Mini Cooper SE 2" }, getCar), "Mini Cooper SE 2");
  assert.equal(defaultCarName({ carId: "gone", label: "" }, getCar), "Car");
  assert.equal(defaultCarName(null, getCar), "Car");
});

test("THE LONGEST NAME IN THE DATASET IS NOT CLIPPED AT THE CAP", () => {
  // Ten cars have a make plus model over 40 characters, which is what the cap
  // was raised to 64 for. The name is stored whole, and a copy of it still gets
  // its number.
  const name = defaultCarName({ carId: "amgE53" }, getCar);
  assert.equal(name, "Mercedes-Benz AMG E53 Hybrid 4matic Plus (station wagon)");
  assert.equal(name.length, 56);
  assert.ok(name.length <= MAX_CUSTOM_NAME_LEN, `the default no longer fits the cap: ${name.length}`);

  const copy = nextCopyName(name, [name], MAX_CUSTOM_NAME_LEN);
  assert.equal(copy, `${name} 2`, "the longest car in the dataset cannot be copied without clipping");
});

test("the read path puts a name on every car and leaves the named ones alone", () => {
  // The whole of the backfill for an existing user, whose records carry
  // `name: ""`. It happens where the payload is READ, so a page load costs no
  // write: the name reaches disk with the next real one.
  const cars = [
    { id: "a", carId: "rav4", name: "" },
    { id: "b", carId: CUSTOM_CAR_ID, name: "   " },
    { id: "c", carId: "gone", label: "2016 Land Rover Range Rover" },
    { id: "d", carId: "prius23", name: "Weekend" },
  ];
  assert.deepEqual(
    withDefaultNames(cars, getCar).map((c) => c.name),
    ["Toyota RAV4 Prime", "My own car", "Land Rover Range Rover", "Weekend"],
  );
  assert.equal(withDefaultNames(cars, getCar)[3], cars[3], "a named record was rebuilt for nothing");
  assert.deepEqual(withDefaultNames(null, getCar), []);
  assert.deepEqual(withDefaultNames(undefined, getCar), []);
});

test("the backfill copies rather than writing through to the record it read", () => {
  // It runs on the read, so the list it is handed is the one another reader may
  // still be holding.
  const cars = [{ id: "a", carId: "rav4", name: "" }];
  withDefaultNames(cars, getCar);
  assert.equal(cars[0].name, "", "the payload was mutated where it was only meant to be read");
});

// --- Chip labels ------------------------------------------------------------

test("a chip says the make and model, not the year", () => {
  assert.equal(chipBaseLabel({ carId: "rav4" }, getCar), "Toyota RAV4 Prime");
});

test("a user's own name beats the dataset model", () => {
  assert.equal(chipBaseLabel({ carId: "rav4", name: "Commuter" }, getCar), "Commuter");
});

test("a blank or whitespace name falls through to the default", () => {
  // The window between clearing the field and leaving it. Nothing on screen may
  // go nameless while the user is mid-edit.
  assert.equal(chipBaseLabel({ carId: "rav4", name: "   " }, getCar), "Toyota RAV4 Prime");
  assert.equal(chipBaseLabel({ carId: "rav4", name: "" }, getCar), "Toyota RAV4 Prime");
});

test("the live row beats the stored label, so a reseed can correct a name", () => {
  const saved = { carId: "rav4", label: "2024 Toyota RAV4 Preem" };
  assert.equal(chipBaseLabel(saved, getCar), "Toyota RAV4 Prime");
});

test("an orphaned car is named from its stored label rather than from nothing", () => {
  const saved = { carId: "gone", label: "2016 Land Rover Range Rover" };
  assert.equal(chipBaseLabel(saved, getCar), "Land Rover Range Rover");
});

test("a custom car with no name says so instead of reading the dataset", () => {
  assert.equal(chipBaseLabel({ carId: CUSTOM_CAR_ID }, getCar), "My own car");
  assert.equal(chipBaseLabel({ carId: CUSTOM_CAR_ID, name: "The van" }, getCar), "The van");
});

test("a getCar that throws costs the label, never the chip", () => {
  const boom = () => { throw new Error("dataset still loading"); };
  assert.equal(chipBaseLabel({ carId: "rav4", label: "2024 Toyota RAV4 Prime" }, boom), "Toyota RAV4 Prime");
  assert.equal(chipBaseLabel({ carId: "rav4" }, boom), "Car");
});

test("chipFullName is the year-make-model, and empty when nothing can supply one", () => {
  assert.equal(chipFullName({ carId: "rav4" }, getCar), "2024 Toyota RAV4 Prime");
  assert.equal(chipFullName({ carId: "gone", label: "2019 Kia Niro" }, getCar), "2019 Kia Niro");
  assert.equal(chipFullName({ carId: CUSTOM_CAR_ID, name: "The van" }, getCar), "");
});

// --- Accessible names -------------------------------------------------------

test("the accessible name keeps the visible text as a prefix (Label in Name)", () => {
  // A voice-control user says what they can see, so the disambiguating digit
  // has to survive into the name.
  assert.equal(
    chipAccessibleName("Prius Prime 2", "2021 Toyota Prius Prime"),
    "Prius Prime 2, 2021 Toyota Prius Prime",
  );
});

test("the accessible name does not say the same thing twice", () => {
  assert.equal(chipAccessibleName("2019 Kia Niro", "2019 Kia Niro"), "2019 Kia Niro");
  assert.equal(chipAccessibleName("The van", ""), "The van");
});

test("TWO CARS MAY HOLD ONE NAME, AND BOTH CHIPS READ IT UNCHANGED", () => {
  // Not a defect to repair. The opaque id is what switching and removing act
  // on, so identical names are already safe, and renaming one of them behind
  // the user is the louder wrong.
  const cars = [
    { id: "a", carId: "prius23", name: "Work" },
    { id: "b", carId: "prius21", name: "Work" },
  ];
  assert.deepEqual(buildChips(cars, getCar), [
    { id: "a", label: "Work", accessibleName: "Work, 2023 Toyota Prius Prime" },
    { id: "b", label: "Work", accessibleName: "Work, 2021 Toyota Prius Prime" },
  ]);
  // And the record each name belongs to is still told apart by its id.
  assert.equal(chipLabelFor(cars, "b", getCar), "Work");
  assert.equal(checkedChipId(cars[1]), "b");
});

test("buildChips survives junk in place of a list", () => {
  assert.deepEqual(buildChips(null, getCar), []);
  assert.deepEqual(buildChips(undefined, getCar), []);
});

test("one record's chip label is the name that record is carrying", () => {
  const cars = [
    { id: "a", carId: "prius23", name: "Toyota Prius Prime" },
    { id: "b", carId: "prius21", name: "Toyota Prius Prime 2" },
  ];
  assert.equal(chipLabelFor(cars, "a", getCar), "Toyota Prius Prime");
  assert.equal(chipLabelFor(cars, "b", getCar), "Toyota Prius Prime 2");
});

test("a chip label for a record that is not in the list is empty, not a guess", () => {
  assert.equal(chipLabelFor([{ id: "a", carId: "rav4" }], "gone", getCar), "");
  assert.equal(chipLabelFor(null, "a", getCar), "");
});

test("NO CHIP READS AS CHECKED FOR A CAR THE TILE IS NOT SHOWING", () => {
  // The rollback shape: an older build writes prefs.carId and knows nothing
  // about this store, so the two can point at different cars. The tile already
  // falls back to the prefs path there; the row used to go on reading activeId
  // raw and check a chip for a car that was not on screen.
  assert.equal(checkedChipId(null), null);
  assert.equal(checkedChipId(undefined), null);
});

test("the checked chip is the record the mismatch guard answered with", () => {
  assert.equal(checkedChipId({ id: "b", carId: "prius21" }), "b");
});

// --- What a copy is called --------------------------------------------------

test("A STORED NAME DOES NOT RENUMBER WHEN THE CAR BEFORE IT IS REMOVED", () => {
  // The defect this whole change exists for. A chip suffix used to be computed
  // from POSITION, so removing "Toyota Prius Prime 2" repainted "Toyota Prius
  // Prime 3" as "Toyota Prius Prime 2", and the car the user had learned
  // answered to another car's name.
  const cars = [
    { id: "a", carId: "prius23", name: "Toyota Prius Prime" },
    { id: "b", carId: "prius23", name: "Toyota Prius Prime 2" },
    { id: "c", carId: "prius23", name: "Toyota Prius Prime 3" },
  ];
  const labels = ["Toyota Prius Prime", "Toyota Prius Prime 2", "Toyota Prius Prime 3"];
  assert.deepEqual(buildChips(cars, getCar).map((c) => c.label), labels);
  assert.deepEqual(
    buildChips(cars.filter((c) => c.id !== "b"), getCar).map((c) => c.label),
    [labels[0], labels[2]],
    "the survivors were renumbered under the user",
  );
  // And the same list read back the other way: nothing moves when the FIRST
  // car goes either.
  assert.deepEqual(
    buildChips(cars.filter((c) => c.id !== "a"), getCar).map((c) => c.label),
    [labels[1], labels[2]],
  );
});

test("a named car hands the copy its NAME", () => {
  assert.equal(copyBaseName({ id: "a", carId: "prius23", name: "Commute" }, getCar), "Commute");
  assert.equal(copyBaseName({ id: "a", carId: "prius23", name: "  Commute  " }, getCar), "Commute");
});

test("copying a copy stays in one family instead of stacking numbers", () => {
  // "Add a copy" selects the car it just made, so the next press copies the
  // COPY. Reading "Toyota Prius Prime 2" as a fresh base gives "Toyota Prius
  // Prime 2 2".
  assert.equal(
    copyBaseName({ id: "b", carId: "prius23", name: "Toyota Prius Prime 2" }, getCar),
    "Toyota Prius Prime",
  );
  assert.equal(
    copyBaseName({ id: "b", carId: "prius23", name: "Toyota Prius Prime 10" }, getCar),
    "Toyota Prius Prime",
  );
});

test("a typed name that ends in a number is not taken apart", () => {
  // Only a number sitting on this car's OWN default name is one this rule put
  // there. Stripping any trailing digit would copy a "Model 3" as a "Model 4",
  // which names the car after a different car.
  assert.equal(copyBaseName({ id: "a", carId: "prius23", name: "Model 3" }, getCar), "Model 3");
  assert.equal(copyBaseName({ id: "a", carId: "prius23", name: "Commute 2" }, getCar), "Commute 2");
});

test("the taken set is what the row is actually showing", () => {
  const cars = [
    { id: "a", carId: "prius23", name: "Toyota Prius Prime" },
    { id: "b", carId: "prius21", name: "Toyota Prius Prime 2" },
    { id: "c", carId: "rav4", name: "Weekend" },
  ];
  assert.deepEqual(
    [...takenCarNames(cars, getCar)].sort(),
    ["Toyota Prius Prime", "Toyota Prius Prime 2", "Weekend"],
  );
  assert.deepEqual([...takenCarNames(null, getCar)], []);
});

test("the first copy takes 2 and the next takes 3", () => {
  assert.equal(nextCopyName("Prius Prime", ["Prius Prime"], MAX_CUSTOM_NAME_LEN), "Prius Prime 2");
  assert.equal(
    nextCopyName("Prius Prime", ["Prius Prime", "Prius Prime 2"], MAX_CUSTOM_NAME_LEN),
    "Prius Prime 3",
  );
});

test("a number a removal freed is taken by the next copy", () => {
  // A new car taking a free name, which is not the act a stored name exists to
  // prevent: nothing on screen is renamed by it.
  assert.equal(nextCopyName("Car", ["Car", "Car 3", "Car 4"], MAX_CUSTOM_NAME_LEN), "Car 2");
});

test("a copy of a named car is numbered off that name", () => {
  assert.equal(nextCopyName("Commute", ["Commute"], MAX_CUSTOM_NAME_LEN), "Commute 2");
  assert.equal(nextCopyName("Commute", ["Commute", "Commute 2"], MAX_CUSTOM_NAME_LEN), "Commute 3");
});

test("THE NUMBER SURVIVES THE CAP AND THE BASE IS WHAT GETS CLIPPED", () => {
  const long = "W".repeat(MAX_CUSTOM_NAME_LEN);
  const name = nextCopyName(long, [long], MAX_CUSTOM_NAME_LEN);
  assert.equal(name.length, MAX_CUSTOM_NAME_LEN, `the cap was exceeded: ${name.length}`);
  assert.equal(name, `${"W".repeat(MAX_CUSTOM_NAME_LEN - 2)} 2`);

  // A two-digit number takes its extra character off the base, not off itself.
  const used = [long];
  for (let n = 2; n <= 9; n++) used.push(`${"W".repeat(MAX_CUSTOM_NAME_LEN - 2)} ${n}`);
  const tenth = nextCopyName(long, used, MAX_CUSTOM_NAME_LEN);
  assert.equal(tenth, `${"W".repeat(MAX_CUSTOM_NAME_LEN - 3)} 10`);
  assert.equal(tenth.length, MAX_CUSTOM_NAME_LEN);
});

test("clipping the base never leaves a space sitting before the number", () => {
  assert.equal(nextCopyName("Weekend car", [], 10), "Weekend 2");
});

test("a clip never lands inside a character", () => {
  const base = `${"W".repeat(MAX_CUSTOM_NAME_LEN - 3)}\u{1F697}`; // one unit under the cap, ending in a car emoji
  assert.equal(base.length, MAX_CUSTOM_NAME_LEN - 1);

  const name = nextCopyName(base, [base], MAX_CUSTOM_NAME_LEN);
  assert.ok(name.isWellFormed(), `a lone surrogate survived: ${JSON.stringify(name)}`);
  assert.doesNotThrow(() => encodeURIComponent(name));
  assert.ok(name.length <= MAX_CUSTOM_NAME_LEN, `the cap was exceeded: ${name.length}`);
  // The emoji does not fit in the units the number leaves, so it goes whole.
  assert.equal(name, `${"W".repeat(MAX_CUSTOM_NAME_LEN - 3)} 2`);
});

test("whole characters are kept, not merely whole code points", () => {
  // A code-point clip passes the test above and still breaks both of these.
  const accented = `${"W".repeat(MAX_CUSTOM_NAME_LEN - 4)}e\u0301e\u0301`; // exactly the cap, two combining pairs
  assert.equal(accented.length, MAX_CUSTOM_NAME_LEN);
  assert.equal(
    nextCopyName(accented, [accented], MAX_CUSTOM_NAME_LEN),
    `${"W".repeat(MAX_CUSTOM_NAME_LEN - 4)}e\u0301 2`,
  );

  const family = `${"W".repeat(27)}\u{1F468}\u200D\u{1F469}\u200D\u{1F467}`; // 27 + 8 units
  const copy = nextCopyName(family, [family], 32);
  assert.ok(copy.isWellFormed());
  assert.equal(copy, `${"W".repeat(27)} 2`, "the family is dropped whole rather than split");
});

test("nextCopyName answers nothing when there is nothing to name", () => {
  for (const junk of ["", "   ", null, undefined, 7]) {
    assert.equal(nextCopyName(junk, ["Car"], MAX_CUSTOM_NAME_LEN), "");
  }
  assert.equal(nextCopyName("Car", null, MAX_CUSTOM_NAME_LEN), "Car 2");
  assert.equal(nextCopyName("Car", ["Car"], null), "Car 2", "no cap is not a zero-length cap");
});

test("the module still imports on an engine with no Intl.Segmenter", async () => {
  const real = Intl.Segmenter;
  delete Intl.Segmenter;
  try {
    assert.equal(Intl.Segmenter, undefined, "the mask did not take");
    // Cache-busted so the module EVALUATES again while the constructor is gone.
    const m = await import("../js/myCarsUi.js?no-segmenter");
    assert.equal(typeof m.nextCopyName, "function");

    // The fallback may drop the whole emoji, but it may never leave half of one.
    const base = `${"W".repeat(MAX_CUSTOM_NAME_LEN - 3)}\u{1F697}`;
    const name = m.nextCopyName(base, [base], MAX_CUSTOM_NAME_LEN);
    assert.ok(name.isWellFormed(), `a lone surrogate survived: ${JSON.stringify(name)}`);
    assert.doesNotThrow(() => encodeURIComponent(name));
    assert.equal(name, `${"W".repeat(MAX_CUSTOM_NAME_LEN - 3)} 2`);
  } finally {
    Intl.Segmenter = real;
  }
});

test("three presses of Add a copy give 2, 3 and 4", () => {
  // The whole rule, composed the way addCurrentCar composes it. Each press
  // copies the car the last one selected, so the base has to survive the round
  // trip through a stored name.
  let cars = [{ id: "a", carId: "prius23", name: defaultCarName({ carId: "prius23" }, getCar) }];
  let source = cars[0];
  const minted = [];
  for (let i = 0; i < 3; i++) {
    const name = nextCopyName(copyBaseName(source, getCar), takenCarNames(cars, getCar), MAX_CUSTOM_NAME_LEN);
    minted.push(name);
    source = { id: `c${i}`, carId: "prius23", name };
    cars = [...cars, source];
  }
  assert.deepEqual(minted, ["Toyota Prius Prime 2", "Toyota Prius Prime 3", "Toyota Prius Prime 4"]);
  assert.deepEqual(
    buildChips(cars, getCar).map((c) => c.label),
    ["Toyota Prius Prime", "Toyota Prius Prime 2", "Toyota Prius Prime 3", "Toyota Prius Prime 4"],
  );
});

test("THE WHOLE SEQUENCE: add, copy, copy, remove the middle, clear a name, reuse a name", () => {
  const chips = (list) => buildChips(list, getCar).map((c) => c.label);
  const copyOf = (list, source) =>
    nextCopyName(copyBaseName(source, getCar), takenCarNames(list, getCar), MAX_CUSTOM_NAME_LEN);

  // An add names the record, so nothing in the list is ever nameless.
  const a = { id: "a", carId: "prius23", name: newCarName("", "", defaultCarName({ carId: "prius23" }, getCar)) };
  let cars = [a];
  assert.deepEqual(chips(cars), ["Toyota Prius Prime"]);

  const b = { id: "b", carId: "prius23", name: copyOf(cars, a) };
  cars = [...cars, b];
  assert.equal(b.name, "Toyota Prius Prime 2");

  // The copy is what the next press copies, and its name must not be numbered
  // again on the way out or on the way back onto the row.
  const c = { id: "c", carId: "prius23", name: copyOf(cars, b) };
  cars = [...cars, c];
  assert.equal(c.name, "Toyota Prius Prime 3");
  assert.deepEqual(chips(cars), ["Toyota Prius Prime", "Toyota Prius Prime 2", "Toyota Prius Prime 3"]);

  // Removing the middle car leaves both survivors saying exactly what they said.
  const survivors = cars.filter((x) => x.id !== "b");
  assert.deepEqual(chips(survivors), ["Toyota Prius Prime", "Toyota Prius Prime 3"]);
  // And the number the removal freed is a NEW car's to take, which renames
  // nothing on screen.
  assert.equal(copyOf(survivors, survivors[0]), "Toyota Prius Prime 2");

  // Clearing a name settles back on the default when the field is left.
  cars = cars.map((x) => (x.id === "b" ? { ...x, name: chipBaseLabel({ ...x, name: "" }, getCar) } : x));
  assert.deepEqual(chips(cars), ["Toyota Prius Prime", "Toyota Prius Prime", "Toyota Prius Prime 3"]);

  // Two chips may legitimately read one name, and no third car is touched by it.
  cars = cars.map((x) => (x.id === "a" ? { ...x, name: "Toyota Prius Prime 3" } : x));
  assert.deepEqual(chips(cars), ["Toyota Prius Prime 3", "Toyota Prius Prime", "Toyota Prius Prime 3"]);
});

// --- What the car tile says -------------------------------------------------

test("a carId the dataset has dropped is an orphan, not an empty tile", () => {
  // THE BUG. boot() asked the dataset and nothing else, so a reseed that drops
  // a carId took the user's car away from them on screen: the numbers loaded,
  // the ceiling came off the snapshot, and the tile said "Select your car".
  assert.equal(
    carTileSource("ghost-car-9999", null, { carId: "ghost-car-9999", label: "2031 Ghost Motors Phantom", name: "Ghost" }),
    "orphan",
  );
});

test("the two genuinely empty states stay empty, which is what keeps them different", () => {
  // No carId at all is a first run. A carId with no record behind it is a dead
  // store, a car the cap would not take, or the mismatch guard refusing to
  // answer, and all three fall back to prefs the way they did before saved cars
  // existed. Neither has a car to name.
  assert.equal(carTileSource(null, null, null), "none");
  assert.equal(carTileSource("", null, null), "none");
  assert.equal(carTileSource("ghost-car-9999", null, null), "none");
});

test("a record with no carId cannot conjure a car", () => {
  // activeSavedCar cannot hand one back today, because it returns null the
  // moment prefs.carId is falsy. This pins that the rule does not depend on
  // that guard holding somewhere else.
  assert.equal(carTileSource(null, null, { carId: "rav4", name: "Commuter" }), "none");
});

test("a live dataset row is a dataset car even when a record is sitting on it", () => {
  // The ordinary case, and the one a swapped clause would silently reroute
  // through the orphan branch, where the tile is painted from the snapshot
  // instead of the row a reseed just corrected.
  assert.equal(carTileSource("rav4", ROWS.rav4, { carId: "rav4", label: "2024 Toyota RAV4" }), "dataset");
  assert.equal(carTileSource("rav4", ROWS.rav4, null), "dataset");
});

test("the custom car is answered before the row lookup, so it is never an orphan", () => {
  // It HAS no row. Reaching the orphan branch would paint it from a label it
  // does not carry either, and open it under a different rule than the one it
  // has always had.
  assert.equal(carTileSource(CUSTOM_CAR_ID, null, { carId: CUSTOM_CAR_ID, name: "Runabout" }), "custom");
  assert.equal(carTileSource(CUSTOM_CAR_ID, null, null), "custom");
});

test("a name the user typed beats the make and model, which is the reload bug", () => {
  // boot() wrote `${car.make} ${car.model}` into the tile directly, so a car the
  // user had named came back from a reload calling itself something else.
  assert.equal(carSummaryLabel({ carId: "rav4", name: "Commuter" }, ROWS.rav4, ""), "Commuter");
});

test("no name falls to the make and model, which is what the tile said before", () => {
  assert.equal(carSummaryLabel({ carId: "rav4" }, ROWS.rav4, ""), "Toyota RAV4 Prime");
});

test("a whitespace-only name is not a name", () => {
  assert.equal(carSummaryLabel({ carId: "rav4", name: "   " }, ROWS.rav4, ""), "Toyota RAV4 Prime");
});

test("the name wins over a row AND a label, not merely over one of them", () => {
  assert.equal(
    carSummaryLabel({ carId: "rav4", label: "2024 Toyota RAV4 Prime", name: "Weekend" }, ROWS.rav4, "Runabout"),
    "Weekend",
  );
});

test("the row beats the stored label, so a reseed corrects the tile", () => {
  // The same precedence chipBaseLabel and savedCarCeilingKw use: the live row
  // answers before the snapshot taken when the car was saved.
  assert.equal(carSummaryLabel({ carId: "rav4", label: "2024 Toyota RAV4" }, ROWS.rav4, ""), "Toyota RAV4 Prime");
});

test("no row and no name uses the stored label before customName", () => {
  // An orphaned car: the dataset row is gone, the label snapshotted when it was
  // saved is not, and that snapshot names the car better than a mirror slot
  // that was never about this car.
  assert.equal(
    carSummaryLabel({ carId: "gone", label: "2016 Land Rover Range Rover" }, null, "Runabout"),
    "2016 Land Rover Range Rover",
  );
});

test("an orphan that carries a name is called by it, not by its label", () => {
  // The whole orphan record, as a reseed leaves it: no row, a label snapshot,
  // and a name the user typed. The name is what they call this car, and losing
  // it to the snapshot would be the reload bug again one branch over.
  assert.equal(
    carSummaryLabel({ carId: "ghost-car-9999", label: "2031 Ghost Motors Phantom", name: "Ghost" }, null, ""),
    "Ghost",
  );
});

test("no record at all is the expression that shipped: customName, then My car", () => {
  // A dead store, the mismatch guard refusing to answer, and a car the cap
  // would not take all arrive here with saved === null. This is the case the
  // three routed call sites used to write out by hand.
  assert.equal(carSummaryLabel(null, null, "Runabout"), "Runabout");
  assert.equal(carSummaryLabel(null, null, ""), "My car");
  assert.equal(carSummaryLabel(null, null, undefined), "My car");
});

test("a custom car carries no label, so an empty name still reaches customName", () => {
  // selectMyCar writes a custom record from { name } alone, so its label is "".
  // That is what keeps the custom branch identical to the string it replaced.
  assert.equal(carSummaryLabel({ carId: CUSTOM_CAR_ID, label: "", name: "" }, null, "Runabout"), "Runabout");
  assert.equal(carSummaryLabel({ carId: CUSTOM_CAR_ID, label: "", name: "" }, null, ""), "My car");
});

test("THE HEADING READS WHAT THE CHECKED CHIP READS, DUPLICATE NAMES INCLUDED", () => {
  // Two cars the user has given one name. Both chips read it, and the heading
  // has to read it too rather than inventing a digit the row is not showing.
  const cars = [
    { id: "a", carId: "prius23", name: "Toyota Prius Prime 2" },
    { id: "b", carId: "prius23", name: "Toyota Prius Prime 2" },
  ];
  const chips = buildChips(cars, getCar);
  assert.deepEqual(chips.map((c) => c.label), ["Toyota Prius Prime 2", "Toyota Prius Prime 2"]);
  for (const [i, saved] of cars.entries()) {
    assert.equal(
      carSummaryLabel(saved, ROWS.prius23, ""),
      chips[i].label,
      "the largest text on screen must name the chip that is checked",
    );
  }
});

test("THE HEADING AND THE CHIP READ THE SAME STORED NAME, WHATEVER IT IS", () => {
  // The two largest pieces of text about one car. They used to be built by
  // different rules, so a rename moved one and not the other.
  const cars = [
    { id: "a", carId: "prius23", name: "Toyota Prius Prime" },
    { id: "b", carId: "prius21", name: "Weekend" },
    { id: "c", carId: CUSTOM_CAR_ID, name: "My own car" },
  ];
  const chips = buildChips(cars, getCar);
  for (const [i, saved] of cars.entries()) {
    const row = saved.carId === CUSTOM_CAR_ID ? null : ROWS[saved.carId];
    assert.equal(carSummaryLabel(saved, row, ""), chips[i].label);
  }
});

test("the name field shows the raw stored name, including the number a copy got", () => {
  // The heading is read; this field is EDITED, and renameMyCar writes whatever
  // is in it, so it may not show a character the record is not carrying.
  const saved = { id: "b", carId: "prius23", name: "Toyota Prius Prime 2" };
  assert.equal(chipLabelFor([{ id: "a", carId: "prius23", name: "Toyota Prius Prime" }, saved], "b", getCar),
    "Toyota Prius Prime 2");
  assert.equal(nameFieldValue(saved, false, ""), "Toyota Prius Prime 2");
});

// --- The name field ---------------------------------------------------------

test("THE NAME FIELD IS EMPTY FOR A SAVED CAR THAT HAS NO NAME", () => {
  // H-6, and the reproduction it was filed from. A custom car named "Van", then
  // a Prius Prime added beside it: the field fell through to prefs.customName
  // for any unnamed car, so "Adjust details" opened reading "Van" under a
  // heading that said Toyota, and one keystroke renamed the PRIUS to "Vane".
  const prius = { id: "c2", carId: "prius23", label: "2023 Toyota Prius Prime", name: "" };
  assert.equal(nameFieldValue(prius, false, "Van"), "");

  // The custom car it sits next to still answers with its own name.
  const custom = { id: "c1", carId: CUSTOM_CAR_ID, label: "", name: "Van" };
  assert.equal(nameFieldValue(custom, true, "Van"), "Van");
});

test("the record answers before the slot, at every car count", () => {
  assert.equal(nameFieldValue({ carId: "rav4", name: "Weekend" }, false, "Van"), "Weekend");
  // Even for the custom car, where the two normally hold the same string:
  // saveCarName writes the record first and mirrors it, so a slot that has
  // drifted is the stale one.
  assert.equal(nameFieldValue({ carId: CUSTOM_CAR_ID, name: "Nellie" }, true, "Van"), "Nellie");
});

test("no record leaves the custom car its name and every other car nothing", () => {
  // A dead store, or the mismatch guard refusing to answer. The custom car's
  // path here is the single-car screen that shipped before this feature.
  assert.equal(nameFieldValue(null, true, "Van"), "Van");
  assert.equal(nameFieldValue(null, false, "Van"), "");
  assert.equal(nameFieldValue(undefined, true, ""), "");
});

test("the field never answers with anything but a string", () => {
  for (const bad of [undefined, null, 42, {}, [], true]) {
    assert.equal(nameFieldValue({ name: bad }, false, bad), "", `${String(bad)} reached the field`);
    assert.equal(nameFieldValue(bad, true, bad), "", `${String(bad)} reached the field as the slot`);
  }
  assert.equal(nameFieldValue({ name: "  " }, true, "  "), "", "whitespace is not a name in either half");
});

test("the slot answers for the custom car and for no other", () => {
  // The rule both readers share, stated once. migrateCars already held it on
  // the write side: customName becomes the custom car's name and no other's.
  assert.equal(legacyNameSlot(true, "Van"), "Van");
  assert.equal(legacyNameSlot(false, "Van"), "");
  assert.equal(legacyNameSlot(true, "  Van  "), "Van");
  assert.equal(legacyNameSlot(true, undefined), "");
  assert.equal(legacyNameSlot(false, undefined), "");
});

test("an orphan with no label stops borrowing the custom car's name", () => {
  // The narrow half of the same defect, one function over. carSummaryLabel
  // consults the slot last, and an orphan whose label snapshot is empty - a
  // carId the dataset could not answer for at migration time - reached it.
  const orphan = { carId: "gone", label: "", name: "" };
  assert.equal(carSummaryLabel(orphan, null, legacyNameSlot(false, "Van")), "My car");
  // And the custom car, which is what the slot is for, is untouched.
  assert.equal(
    carSummaryLabel({ carId: CUSTOM_CAR_ID, label: "", name: "" }, null, legacyNameSlot(true, "Van")),
    "Van",
  );
});

// --- Keyboard ---------------------------------------------------------------

test("Right and Down advance, and wrap at the end", () => {
  assert.equal(nextChipIndex(0, 3, "ArrowRight"), 1);
  assert.equal(nextChipIndex(1, 3, "ArrowDown"), 2);
  assert.equal(nextChipIndex(2, 3, "ArrowRight"), 0);
});

test("Left and Up retreat, and wrap at the start", () => {
  assert.equal(nextChipIndex(2, 3, "ArrowLeft"), 1);
  assert.equal(nextChipIndex(1, 3, "ArrowUp"), 0);
  assert.equal(nextChipIndex(0, 3, "ArrowLeft"), 2);
});

test("Home and End jump to the ends", () => {
  // The combobox leaves these to the caret; a radiogroup has no text, so it
  // takes them.
  assert.equal(nextChipIndex(2, 4, "Home"), 0);
  assert.equal(nextChipIndex(1, 4, "End"), 3);
});

test("an unrelated key does not move the selection", () => {
  assert.equal(nextChipIndex(1, 3, "Enter"), 1);
  assert.equal(nextChipIndex(1, 3, "a"), 1);
  assert.equal(nextChipIndex(1, 3, "Tab"), 1);
});

test("an out-of-range index resolves to the first chip, never to -1", () => {
  // A radiogroup always has a selection, so there is no "nothing active" state.
  assert.equal(nextChipIndex(-1, 3, "ArrowRight"), 1);
  assert.equal(nextChipIndex(99, 3, "ArrowLeft"), 2);
  assert.equal(nextChipIndex(null, 3, "Home"), 0);
});

test("an empty row answers -1 for every key", () => {
  assert.equal(nextChipIndex(0, 0, "ArrowRight"), -1);
  assert.equal(nextChipIndex(0, -2, "Home"), -1);
});

test("a single chip stays put in both directions", () => {
  assert.equal(nextChipIndex(0, 1, "ArrowRight"), 0);
  assert.equal(nextChipIndex(0, 1, "ArrowLeft"), 0);
});

// --- Copy -------------------------------------------------------------------

test("the cap message names the limit and the way out", () => {
  const msg = atCapMessage(5);
  assert.match(msg, /5 cars/);
  assert.match(msg, /Remove one/);
});

test("every reason addMyCar can refuse with comes back as a sentence", () => {
  // Driven through the real store rather than a list of strings, so this
  // enumerates what addMyCar ACTUALLY answers. The bug class being closed is
  // "the store said no and the screen said nothing": "full" was the only reason
  // anything ever handled, and "invalid" fell through to silence.
  let full = emptyCarsState();
  for (let i = 0; i < MAX_MY_CARS; i++) {
    full = addMyCar(full, { carId: `car${i}`, label: `Car ${i}` }).state;
  }
  const refusals = [
    addMyCar(full, { carId: "one-too-many" }),
    addMyCar(emptyCarsState(), { label: "no carId and no numbers" }),
  ];
  const seen = new Set();
  for (const res of refusals) {
    assert.equal(res.ok, false, "this draft was supposed to be refused");
    seen.add(res.reason);
    const msg = addRefusalMessage(res.reason, MAX_MY_CARS);
    assert.equal(typeof msg, "string");
    assert.ok(msg.trim().length > 0, `refusal "${res.reason}" comes back as nothing`);
  }
  assert.deepEqual([...seen].sort(), ["full", "invalid"], "addMyCar grew a reason nothing here has seen");
});

test("the refusal message is total, so a reason added later still says something", () => {
  for (const reason of ["invalid", "not-found", "", "something-new", null, undefined]) {
    const msg = addRefusalMessage(reason, 5);
    assert.ok(msg.trim().length > 0, `refusal "${String(reason)}" comes back as nothing`);
  }
});

test("the cap refusal is the cap message itself, not a paraphrase of it", () => {
  assert.equal(addRefusalMessage("full", 5), atCapMessage(5));
  assert.equal(addRefusalMessage("full", 3), atCapMessage(3));
});

test("a failed write says the car was not added, and does not blame the numbers", () => {
  // The caller discards the new state on a failed write, so "not added" is the
  // outcome. "Could not be saved" was both the wrong vocabulary and the wrong
  // fact: nothing was added, and the numbers in the fields were never at risk.
  const msg = addWriteFailedMessage("unavailable");
  assert.match(msg, /not added/);
  assert.doesNotMatch(msg, /sav/i, `a write failure blames the save: ${msg}`);
});

test("a newer build's payload is not reported as a browser blocking site data", () => {
  // LOW-7. saveMyCars refuses for two unrelated reasons and returned one
  // boolean, so a v:99 payload produced "This browser may be blocking site
  // data." The browser is fine. That sends the user to their privacy settings
  // for something a reload fixes on its own.
  for (const say of [addWriteFailedMessage("read-only"), removeWriteFailedMessage("read-only")]) {
    assert.doesNotMatch(say, /browser|blocking|site data/i, `the browser is still being blamed: ${say}`);
    assert.match(say, /reload/i, `nothing tells the user the way out: ${say}`);
  }
  for (const say of [addWriteFailedMessage("unavailable"), removeWriteFailedMessage("unavailable")]) {
    assert.match(say, /blocking site data/, `the genuinely blocked store stopped saying so: ${say}`);
  }
});

test("the cause is total over the store's reasons, and an unknown one still says something", () => {
  // A reason added to saveMyCars later must not come back as a blank sentence.
  // The fallback is the blocked-storage one, which names something the user can
  // go and look at.
  for (const reason of ["read-only", "unavailable", "", "something-new", null, undefined]) {
    for (const say of [
      addWriteFailedMessage(reason), removeWriteFailedMessage(reason),
      nameWriteFailedMessage(reason), numbersWriteFailedMessage(reason),
    ]) {
      assert.match(say, /\S\. \S/, `reason "${String(reason)}" lost its cause: ${say}`);
    }
  }
});

test("the add announcement matches the shape of the removal's", () => {
  // The note is a live region and is the only feedback a screen reader gets for
  // either act, so they arrive as a pair.
  assert.equal(addedMessage("Prius Prime 2"), "Added Prius Prime 2.");
  assert.equal(addedMessage("   "), "Added this car.");
  assert.equal(addedMessage(null), "Added this car.");
});

test("the removal announcement matches the shape of the add's", () => {
  // The note is a live region and is the only feedback a screen reader gets for
  // either act, so they arrive as a pair.
  assert.equal(removedMessage("Prius Prime 2"), "Removed Prius Prime 2.");
  assert.equal(removedMessage("   "), "Removed this car.");
  assert.equal(removedMessage(null), "Removed this car.");
});

test("the removal announcement is a statement, never a question", () => {
  // The question is removeConfirmQuestion's job and it has already been asked
  // and answered by the time this is read. An announcement that still ends in a
  // question mark is a removal that never actually happened.
  for (const s of [removedMessage("Van"), removedMessage("")]) {
    assert.ok(!s.includes("?"), `the removal is still asking: ${s}`);
  }
});

test("the remove question names the car and stays a question", () => {
  assert.equal(removeConfirmQuestion("Prius Prime 2"), "Remove Prius Prime 2?");
  assert.equal(removeConfirmQuestion("   "), "Remove this car?");
  assert.equal(removeConfirmQuestion(null), "Remove this car?");
});

test("the remove question names the car the CHIP names, not a car still on screen", () => {
  // THE DEFECT. The question was built from the full year-make-model, which two
  // records of one model share, so removing the second Prius asked "Remove 2023
  // Toyota Prius Prime?" while a chip reading exactly that sat beside it,
  // checked, pointing at the car that was about to survive.
  //
  // Composed the way addCurrentCar composes it, because what tells the two
  // apart is now the name each record was CREATED with.
  const draft = { carId: "prius23", label: "2023 Toyota Prius Prime" };
  let state = emptyCarsState();
  let source = null;
  for (let i = 0; i < 2; i++) {
    const copied = source
      ? nextCopyName(copyBaseName(source, getCar), takenCarNames(state.cars, getCar), MAX_CUSTOM_NAME_LEN)
      : "";
    const res = addMyCar(state, { ...draft, name: newCarName(copied, "", defaultCarName(draft, getCar)) }, getCar);
    assert.ok(res.ok);
    state = res.state;
    source = state.cars[state.cars.length - 1];
  }
  const [first, second] = state.cars;
  assert.equal(first.carId, second.carId, "two records of one model is the case this feature exists for");
  assert.equal(chipFullName(first, getCar), chipFullName(second, getCar), "the full name cannot tell them apart");

  const asked = removeConfirmQuestion(chipLabelFor(state.cars, second.id, getCar));
  assert.equal(asked, "Remove Toyota Prius Prime 2?");
  assert.ok(
    !asked.includes(chipLabelFor(state.cars, first.id, getCar) + "?"),
    `the question names the car that is staying: ${asked}`,
  );
});

test("a refused removal is reported as a refusal, in the add path's own words", () => {
  // H-5. The write can be refused and the removal used to be announced as done
  // anyway, over a disk that still held the car. The outcome differs by one
  // word and the cause is shared, so one condition cannot read as two problems.
  for (const reason of ["read-only", "unavailable"]) {
    const said = removeWriteFailedMessage(reason);
    assert.match(said, /not removed/);
    assert.ok(!said.includes("?"), `a refusal is not a question: ${said}`);
    assert.equal(
      said.replace("not removed", "not added"),
      addWriteFailedMessage(reason),
      `the two write refusals explain ${reason} differently`,
    );
  }
});

test("a refused rename and a refused number edit explain themselves the same way", () => {
  // Both used to discard saveMyCars' answer over an already-mutated myCars, so
  // a rename showed on the chip and the heading, said nothing, and was gone on
  // the next reload. The cause sentence is shared with the add and the removal:
  // one condition told four ways reads as four different problems.
  for (const reason of ["read-only", "unavailable"]) {
    const named = nameWriteFailedMessage(reason);
    const numbered = numbersWriteFailedMessage(reason);
    assert.match(named, /not saved/);
    assert.match(numbered, /not saved/);
    for (const say of [named, numbered]) {
      assert.ok(!say.includes("?"), `a refusal is not a question: ${say}`);
      assert.ok(
        say.endsWith(addWriteFailedMessage(reason).replace("That car was not added. ", "")),
        `${reason} is explained differently from a refused add: ${say}`,
      );
    }
  }
  // The numbers refusal is about the RECORD. carOverrides took them either way,
  // so a flat "not saved" would be the wrong fact as well as the wrong scope.
  assert.match(numbersWriteFailedMessage("read-only"), /to this car/);
});

test("source guard: a rename and a number edit are kept only once the write has happened", () => {
  // The removal's guard one file over, applied to the other two writers. Both
  // reassigned myCars and then threw saveMyCars' answer away, which is the
  // defect that guard exists to describe.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const bodies = {
    saveCarName: ["nameWriteFailedMessage(", "writeCarName("],
    saveCarNumbers: ["numbersWriteFailedMessage("],
  };
  for (const [fn, spoken] of Object.entries(bodies)) {
    const start = src.indexOf(`function ${fn}(`);
    assert.notEqual(start, -1, `${fn} moved or was renamed`);
    const body = src.slice(start, src.indexOf("\n}", start));

    const checked = body.indexOf("saveMyCars(");
    assert.notEqual(checked, -1, `${fn} stopped writing at all`);
    assert.match(
      body.slice(checked, checked + 120),
      /\.ok\)/,
      `${fn}'s write is unchecked again, so a refusal reports as a success`,
    );
    const adopted = body.indexOf("myCars = res.state");
    assert.notEqual(adopted, -1, `${fn} stopped adopting the new state at all`);
    assert.ok(checked < adopted, `${fn} moves the screen on before the disk, which is the divergence this guards`);

    // And someone has to SAY so. A checked write whose answer nobody reports is
    // the same silence with an extra branch in it.
    for (const call of spoken) {
      assert.ok(src.includes(call), `nothing calls ${call} so a refused ${fn} is still silent`);
    }
  }
});

test("no copy in this module uses an em dash", () => {
  // House style, and a chip row is where a stray one would be hardest to spot.
  const copy = [
    atCapMessage(5),
    addControlLabel(true), addControlLabel(false),
    addRefusalMessage("full", 5), addRefusalMessage("invalid", 5),
    addWriteFailedMessage("unavailable"), addWriteFailedMessage("read-only"),
    addedMessage("Volt"), addedMessage(""),
    removedMessage("Volt"), removedMessage(""),
    removeWriteFailedMessage("unavailable"), removeWriteFailedMessage("read-only"),
    nameWriteFailedMessage("unavailable"), nameWriteFailedMessage("read-only"),
    numbersWriteFailedMessage("unavailable"), numbersWriteFailedMessage("read-only"),
    removeConfirmQuestion("Volt"), removeConfirmQuestion(""),
    removeGoneMessage("Volt"), removeGoneMessage(""),
    // The words this module invents when no car, row or record supplies any.
    chipBaseLabel({ carId: CUSTOM_CAR_ID }, getCar), chipBaseLabel({ carId: "gone" }, getCar),
    carSummaryLabel(null, null, ""),
    // And the DEFAULT NAME every record is now created with, which is the copy
    // most likely to be read and least likely to be proofread.
    defaultCarName({ carId: "rav4" }, getCar),
    defaultCarName({ carId: CUSTOM_CAR_ID }, getCar),
    defaultCarName({ carId: "gone", label: "2016 Land Rover Range Rover" }, getCar),
    defaultCarName({ carId: "amgE53" }, getCar),
    defaultCarName(null, getCar),
    ...withDefaultNames([{ id: "a", carId: "rav4" }, { id: "b", carId: CUSTOM_CAR_ID }], getCar).map((c) => c.name),
    // And the name it writes onto a copy, which no user ever proofreads.
    newCarName("Prius Prime 2", ""), newCarName("", "Van"),
    newCarName("", "", defaultCarName({ carId: "rav4" }, getCar)),
    copyBaseName({ carId: CUSTOM_CAR_ID }, getCar), copyBaseName({ carId: "gone" }, getCar),
    nextCopyName("Prius Prime", ["Prius Prime"], MAX_CUSTOM_NAME_LEN),
    // The chip text itself, which now reads a stored name and nothing else.
    ...buildChips(
      [{ id: "a", carId: "prius23" }, { id: "b", carId: "prius23", name: "Toyota Prius Prime 2" }],
      getCar,
    ).flatMap((c) => [c.label, c.accessibleName]),
  ];
  for (const s of copy) {
    assert.ok(!s.includes("\u2014"), `em dash in: ${s}`);
  }
});

// --- Reverts guarded by reading source rather than running it ---------------
//
// The guards below are source scans, not behavior tests, in the same spirit as
// the preset guard in cars.test.mjs and the wiring guards in myCars.test.mjs.
// The code they cover lives in main.js and styles.css, neither of which any
// test in this repo can import, so nothing here can observe what either does.
//
// A failure means "go read the file", not "a bug is proven".
//
// Both are written as a ban on the forbidden thing rather than a match on an
// exact expression, which is the lesson of the preset guard: a positive match
// breaks on a harmless rename or reflow, and then gets rewritten to whatever
// the code now says, which is the opposite of a guard.

test("source guard: the undo is gone, and cannot come back by halves", () => {
  // Undo cost three defects: a double tap deleted two cars and offered one
  // back, a snapshot restore reverted edits made after the removal, and the
  // offer outlived seven unrelated actions because only renderMyCars ended it.
  // All three followed from the snapshot, so the ban is on the snapshot rather
  // than on the wording.
  //
  // It did NOT cost the cross-tab clobber, and this comment used to claim it
  // did. Undo was one route to that; the other is that every tab writes its
  // whole in-memory list, which outlived undo by a fortnight and destroyed a
  // car on an ordinary rename. refreshMyCarsFromStore is what holds it, pinned
  // in myCars.test.mjs.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  for (const gone of ["offerUndo", "undoRemoval"]) {
    assert.equal(src.split(gone).length - 1, 0, `${gone} is back in main.js`);
  }

  // And the way back must not return as a re-add either. addMyCar APPENDS,
  // under a fresh id, so a restore routed through it returns the car to the end
  // of the list rather than to the index it was removed from. This pins that
  // addMyCar still has exactly one caller and that it is the one that grows the
  // list.
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//"));
  assert.equal(code.filter((l) => l.includes("addMyCar(")).length, 1, "addMyCar grew a second caller in main.js");
  const add = src.indexOf("function addCurrentCar(");
  assert.notEqual(add, -1, "addCurrentCar moved or was renamed");
  assert.match(src.slice(add, src.indexOf("\n}", add)), /addMyCar\(/, "and it is no longer addCurrentCar");
});

test("source guard: the confirm is a modal, and the act hangs off its close", () => {
  // The whole reason a <dialog> was chosen over the row of links it replaces:
  // showModal brings the focus trap, Escape, the backdrop and the focus restore
  // with it, and it swallows the second press of a double tap. A confirm
  // rebuilt out of two inline buttons would pass every behavior test in this
  // file and lose all five.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /<dialog[^>]*id="removeCarDialog"/, "the confirm is no longer a dialog element");
  assert.match(html, /<form[^>]*method="dialog"/, "the answer no longer arrives as a returnValue");
  assert.match(src, /showModal\(\)/, "the confirm opens non-modally, so it traps nothing");

  // Escape and "Keep it" have to mean the same thing, and the one thing that
  // makes both one path is listening for the close rather than for the Remove
  // button.
  assert.match(src, /"removeCarDialog"\)\.addEventListener\("close"/, "nothing listens for the dialog closing");
  const click = src.indexOf('$("removeCarBtn").addEventListener("click"');
  assert.notEqual(click, -1, "the remove control lost its handler");
  const line = src.slice(click, src.indexOf("\n", click));
  assert.ok(!line.includes("removeActiveCar"), "the control removes the car directly, with the question in the way");

  // And no backdrop dismiss. The dialog box is narrower and shorter than the
  // control that opens it, so a slow second tap on "Remove this car" landed on
  // the dialog element below its own box and closed the question with no
  // explanation. The same handler measured against a rect while the box has a
  // border-radius, so a click in a rounded corner did nothing at all.
  assert.ok(
    !src.includes('$("removeCarDialog").addEventListener("click"'),
    "the backdrop light dismiss is back, so a second tap where Remove sits dismisses the question",
  );
});

test("source guard: the harmless answer is the dialog's default submit", () => {
  // Implicit submission fires the FIRST submit button in the form. There is no
  // text control here today, so nothing triggers it, but the day someone adds a
  // "type the car name to confirm" field, Enter would mean Remove with no other
  // edit. Source order answers that and CSS puts the visual order back, so both
  // halves are pinned: the swap alone moves Remove under the thumb, the reverse
  // alone is the trap again.
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const from = html.indexOf('class="dialog__actions"');
  assert.notEqual(from, -1, "the dialog's actions row moved or was renamed");
  const actions = html.slice(from, html.indexOf("</div>", from));

  const attrs = [...actions.matchAll(/<button\b([^>]*)>/g)].map((m) => m[1]);
  assert.equal(attrs.length, 2, `the question grew or lost an answer: ${attrs.length} buttons`);
  const firstSubmit = attrs.find((a) => /type="submit"/.test(a));
  assert.ok(firstSubmit, "the answers stopped being submit buttons, so method=dialog carries no answer");
  assert.match(firstSubmit, /id="removeCarNo"/, "Remove is the default submit again, so an added text field would make Enter mean Remove");
  assert.match(firstSubmit, /autofocus/, "the modal no longer opens on the answer that changes nothing");

  const css = readFileSync(new URL("../css/styles.css", import.meta.url), "utf8");
  const rule = css.match(/\.dialog__actions\s*\{[^}]*\}/);
  assert.ok(rule, "the actions row lost its styles, so the buttons are drawn in source order");
  assert.match(rule[0], /flex-direction\s*:\s*row-reverse/, "Remove and Keep it have swapped places on screen");
});

test("source guard: a removal is announced only once the write has happened", () => {
  // H-5. removeMyCar is pure, so `res.ok` says only that the list operation was
  // legal. saveMyCars is what can refuse, and its return used to be discarded
  // over an already-reassigned myCars: the chip went, the note said "Removed
  // X.", the disk still held X, and the next reload brought it back.
  //
  // Pinned as an ORDER plus a ban, not as an expression: the check has to come
  // before the announcement and before the override is dropped, and how it is
  // spelled is not this test's business.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const start = src.indexOf("function removeActiveCar(");
  assert.notEqual(start, -1, "removeActiveCar moved or was renamed");
  const body = src.slice(start, src.indexOf("\n}", start));

  assert.match(body, /removeWriteFailedMessage\(/, "a refused removal says nothing, so the user reads the success note");

  const checked = body.indexOf("saveMyCars(");
  assert.notEqual(checked, -1, "removeActiveCar stopped writing at all");
  assert.match(
    body.slice(checked, checked + 120),
    /\.ok\)/,
    "the removal write is unchecked again, so a refusal reports as a success",
  );
  assert.ok(checked < body.indexOf("removedMessage("), "the removal is announced before the write is known to have happened");
  assert.ok(checked < body.indexOf("forgetCarOverride("), "the rollback override is dropped for a car that is still on disk");

  // And the state must not be adopted ahead of the check. `myCars = res.state`
  // before it is the original defect with a guard bolted on after the fact.
  const adopted = body.indexOf("myCars = res.state");
  assert.notEqual(adopted, -1, "removeActiveCar stopped adopting the new state at all");
  assert.ok(checked < adopted, "the screen moves on before the disk does, which is the divergence this guards");
});

test("source guard: a copy is seeded from the record on screen, not from the model's one slot", () => {
  // H-4. savedCarDraft is pinned properly in myCars.test.mjs, including the two
  // records of one model. What no test there can reach is WHICH store
  // addCurrentCar asks. Putting `prefs.carOverrides?.[prefs.carId]` back as the
  // unconditional seed leaves the whole suite green, and the divergence it
  // creates is invisible until the user switches chips and comes back.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const start = src.indexOf("function addCurrentCar(");
  assert.notEqual(start, -1, "addCurrentCar moved or was renamed");
  const body = src.slice(start, src.indexOf("\n}", start));
  const code = body.split("\n").filter((l) => !l.trim().startsWith("//"));

  assert.match(body, /savedCarDraft\(/, "the copy is seeded from somewhere other than the record on screen");

  // The override survives as the fallback for a car with NO record, so it is
  // the CONDITION that is pinned rather than the absence of the expression.
  const seed = code.find((l) => l.includes("carOverrides"));
  assert.ok(seed, "the unsaved-car fallback is gone, so an unsaved car is copied with no numbers");
  assert.match(seed, /saved \?/, "the override answers unconditionally again, which is the defect");
  assert.ok(seed.indexOf("savedCarDraft(") < seed.indexOf("carOverrides"), "the override is consulted before the record");
});

test("source guard: the question is built from the chip's label, not the full name", () => {
  // M-6. removeCarLabel answers with chipFullName, which two records of one
  // model share, so the question named the car that was about to survive while
  // that car's chip sat beside it, checked. Nothing here can run main.js, so
  // what holds the fix is which rule the prompt is written from.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const start = src.indexOf("function askRemoveCar(");
  assert.notEqual(start, -1, "askRemoveCar moved or was renamed");
  const body = src.slice(start, src.indexOf("\n}", start));

  assert.match(body, /chipLabelFor\(/, "the prompt stopped asking for the chip's own words");
  assert.ok(!body.includes("chipFullName("), "the prompt is back on the name two records share");
  assert.ok(!body.includes("removeCarLabel("), "the prompt is back on the announcement's label, which is chipFullName");
});

test("source guard: removing is not filed under adjusting the car's details", () => {
  // It shipped at the bottom of <details id="tweak">, the disclosure labelled
  // "Adjust details", which put a destructive act behind a closed panel about
  // MPG and battery size. Nobody goes looking there for it.
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const panel = html.indexOf('<details class="tweak" id="tweak">');
  assert.notEqual(panel, -1, "the details panel moved or was renamed");
  const body = html.slice(panel, html.indexOf("</details>", panel));
  assert.ok(!body.includes("removeCarBtn"), "the remove control is back inside Adjust details");

  // And it reads as the add control's pair, with the note that answers both of
  // them last: that order is what teaches the two of them are one list.
  const at = (needle) => {
    const i = html.indexOf(needle);
    assert.notEqual(i, -1, `${needle} is gone from the page`);
    return i;
  };
  assert.ok(at('id="addCarBtn"') < at('id="removeCarBtn"'), "remove no longer follows the control it pairs with");
  assert.ok(at('id="removeCarBtn"') < at('id="myCarsNote"'), "the note no longer follows the acts it announces");
});

test("source guard: the flag that hides the remove control is the one focus reads", () => {
  // focusCarListAction walks [removeCarBtn, addCarBtn] and skips whichever is
  // hidden. That worked for the add control and never for the remove one: the
  // painter hid a WRAPPER around the button, so the button's own flag stayed
  // false at every count and focus() was called on a display:none element,
  // which drops a keyboard user on <body> at the moment they most need to see
  // what their press did.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(!src.includes("removeCarWrap"), "a wrapper is back between the flag and the control");
  assert.ok(!html.includes("removeCarWrap"), "a wrapper is back in the markup");
  assert.match(src, /\$\("removeCarBtn"\)\.hidden = /, "nothing hides the control the focus fallback tests");
});

test("source guard: the legacy name slot is only ever READ for the custom car", () => {
  // H-6. nameFieldValue and legacyNameSlot are pinned properly above and those
  // are real tests. What they cannot reach is which argument main.js hands
  // over: putting a bare `prefs.customName` back into either reader restores
  // the defect with the whole suite green, and the name field then opens on a
  // saved car reading a different car's name, ready to write it down.
  //
  // The WRITES are deliberately not scanned. They are already gated, they are
  // the rollback this release keeps, and one guard answering for two rules is
  // how a guard comes to be edited for the wrong reason.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//"));

  const reads = code.filter((l) => l.includes("prefs.customName") && !l.includes("prefs.customName = "));
  assert.equal(reads.length, 3, "a reader of the slot was added or removed: go read the new line");
  for (const line of reads) {
    assert.match(
      line,
      /legacyNameSlot\(|nameFieldValue\(/,
      `the slot is read without asking whether this is the custom car: ${line.trim()}`,
    );
  }
});

test("source guard: the name field has exactly one reader, and it is the routed one", () => {
  // The other half of the same revert. carNameForField can keep its routed body
  // while writeDisplayValues stops calling it, or a second call site can answer
  // the question its own way; both leave the suite green.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//"));

  const writers = code.filter((l) => l.includes('$("carNickname").value'));
  assert.ok(writers.length, "nothing fills the name field any more");
  for (const line of writers) {
    assert.equal(
      line.trim(),
      '$("carNickname").value = carNameForField();',
      "the name field is filled from somewhere other than the one routed reader",
    );
  }
});

test("source guard: an emptied name field is restored on both ways out of it, written down, and never on input", () => {
  // Nothing in this suite can fire a DOM event, so what holds the restore is
  // the events it is bound to. `input` is the one wrong answer that still looks
  // right: the default would come back on the keystroke that emptied the field,
  // which is a field nobody can clear to type a name of their own. Enter is the
  // one that was missing: it does not blur a bare text input, so the car kept an
  // empty name until the user happened to leave some other way. The whole suite
  // stays green either way.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");

  const start = src.indexOf("function settleCarName(");
  assert.notEqual(start, -1, "the restore moved or was renamed, so neither way out of the field reaches it");
  const handler = src.slice(start, src.indexOf("\n}", start));
  assert.match(handler, /defaultCarName\(/, "the restore decides what the car is called on its own again");

  // ONE restore, reached from BOTH ways out of the field, rather than two that
  // can drift: leaving it, and pressing Enter inside it.
  assert.match(
    src,
    /\$\("carNickname"\)\.addEventListener\("blur", settleCarName\)/,
    "leaving the field no longer settles the name, so an emptied field is left with no name at all",
  );
  const keyAt = src.indexOf('$("carNickname").addEventListener("keydown"');
  assert.notEqual(keyAt, -1, "Enter is not handled, and it does not blur a text input, so it leaves the name empty");
  const onKey = src.slice(keyAt, src.indexOf("\n  });", keyAt));
  assert.match(onKey, /"Enter"/, "the key handler no longer singles Enter out");
  assert.match(onKey, /settleCarName\(\)/, "Enter no longer settles the name the way leaving the field does");
  assert.match(
    onKey,
    /\$\("carNickname"\)\.value = carNameForField\(\)/,
    "Enter settles the name without showing it: the repaint skips a field that still has focus",
  );

  // WRITTEN DOWN, not merely painted, which is the half a name cannot be read
  // back without. The restore hands its default to a helper rather than to the
  // writer direct, so this FOLLOWS the calls out of that helper instead of
  // naming it: a repaint dressed in a save-shaped name has to fail too, and it
  // does, because no painter here reaches either store.
  const entry = handler.match(/(\w+)\(defaultCarName\(/)?.[1];
  assert.ok(entry, "the restore hands its default to nothing, so the name it picks is dropped");
  const reached = new Set();
  // Three hops: enough for another wrapper to be added, short of the depth at
  // which a repaint reaches a writer through some unrelated branch.
  for (let edge = [entry], hop = 0; hop < 3 && edge.length; hop++) {
    const next = [];
    for (const fn of edge) {
      if (reached.has(fn)) continue;
      reached.add(fn);
      const at = src.indexOf(`function ${fn}(`);
      if (at === -1) continue;
      next.push(...[...src.slice(at, src.indexOf("\n}", at)).matchAll(/(\w+)\(/g)].map((m) => m[1]));
    }
    edge = next;
  }
  for (const writer of ["saveMyCars", "savePrefs"]) {
    assert.ok(
      reached.has(writer),
      `${entry}() never reaches ${writer}(), so the restored name is painted but never written down`,
    );
  }

  // One `input` listener on the field, and it is the one that saves what is
  // typed. A restore bolted onto it is the defect above, whole.
  const events = [...src.matchAll(/\$\("carNickname"\)\.addEventListener\("(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    events.filter((e) => e === "input"),
    ["input"],
    "a second input listener is on the name field: if it restores the default, the field can never be cleared",
  );
});

test("source guard: the chip row reads as checked through the mismatch guard", () => {
  // The rule is pinned above, but nothing here can run renderMyCars. What is
  // load bearing is WHICH value the row is painted from: reaching for
  // myCars.activeId again restores the contradiction, and every test stays
  // green because the record and the store agree in all the ordinary cases.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const start = src.indexOf("function renderMyCars(");
  assert.notEqual(start, -1, "renderMyCars moved or was renamed");
  const body = src.slice(start, src.indexOf("\n}", start));

  assert.match(body, /const activeId = checkedChipId\(saved\)/, "the row picks its checked chip its own way again");
  assert.equal(
    body.includes("myCars.activeId"),
    false,
    "the store's own activeId is back in the row, so a chip can check for a car the tile is not showing",
  );
});

test("source guard: a copy is named through the rule, and the legacy slot follows it", () => {
  // The rules are pinned properly above and those are real tests. What they
  // cannot reach is the WIRING. Naming the copy from the seed, or dropping the
  // two lines that move prefs.customName onto the new record, leaves the suite
  // green while the copy comes back from a reload wearing the original's name:
  // that slot is the last value carSummaryLabel and carNameForField consult.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const start = src.indexOf("function addCurrentCar(");
  assert.notEqual(start, -1, "addCurrentCar moved or was renamed");
  const body = src.slice(start, src.indexOf("\n}", start));

  assert.match(body, /nextCopyName\(/, "a copy is named somewhere other than by the numbering rule");
  assert.match(body, /copyBaseName\(/, "the base is decided at the call site again");
  assert.match(body, /newCarName\(/, "main.js decides what a new record is called on its own again");
  assert.match(body, /prefs\.customName = /, "the legacy name slot keeps naming the car the copy came from");
});

test("source guard: a copy lands the caret in the name it was given", () => {
  // Nothing here can run main.js, so what holds this is which two things the
  // add path does after its repaint. The panel is shut by default, and a
  // suggested name behind a closed disclosure is one the user never sees to
  // change. SELECTED rather than focused: a caret parked on the end of
  // "Prius Prime 2" costs thirteen backspaces before their own word starts.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const start = src.indexOf("function addCurrentCar(");
  assert.notEqual(start, -1, "addCurrentCar moved or was renamed");
  const body = src.slice(start, src.indexOf("\n}", start));

  assert.match(body, /\$\("tweak"\)\.open = true/, "the new name is left behind a closed panel");
  assert.match(body, /\$\("carNickname"\)\.select\(\)/, "the suggestion has to be deleted by hand again");
});

test("source guard: every car-tile summary is routed through the naming rule", () => {
  // carSummaryLabel is pinned properly above and those are real tests. What was
  // unheld is the WIRING. boot() used to spell out `${car.make} ${car.model}`,
  // which is how a named car came back from a reload under a name the user
  // never gave it, and putting that expression back leaves the suite green.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");

  assert.match(src, /carSummaryLabel\(/, "main.js stopped asking myCarsUi.js what a car is called");

  const writes = src.split("\n").filter((l) => l.includes('$("carName").textContent ='));
  assert.ok(writes.length >= 5, "the car-tile summary writers moved, were renamed, or were reflowed");
  for (const w of writes) {
    assert.doesNotMatch(
      w,
      /customName|carLabel\(|\.make|\.model/,
      `a summary is built from the car here instead of routed through the rule: ${w.trim()}`,
    );
  }

  // WHICH summary the tile reaches is carTileSource's to say, and boot() is the
  // one caller that has to ask. It used to decide with a bare dataset lookup
  // and an else, so a carId a reseed had dropped fell to the empty state with
  // the record that names it sitting untouched. Putting that lookup back leaves
  // the suite green, because nothing here can run boot().
  //
  // Pinned as an ORDER rather than an exact expression, the way the migration
  // guard in myCars.test.mjs is: the record has to be consulted before the
  // empty state is reached, and how the branches are spelled is not this test's
  // business.
  const boot = src.slice(src.indexOf("function boot("), src.indexOf("\n}", src.indexOf("function boot(")));
  assert.notEqual(boot.length, 0, "boot() moved or was renamed");
  const asked = boot.indexOf("carTileSource(");
  assert.notEqual(asked, -1, "boot() decides the car tile's state on its own again");
  assert.ok(asked < boot.indexOf('"Select your car"'), "the empty state is reached before the record is consulted");
});

test("source guard: a chip switch closes the picker, and closes it in the right order", () => {
  // Pure DOM wiring. The chip row, the picker and the blur timer all live in
  // main.js, which no test here can import, so nothing in this suite can watch
  // the list close. What this pins is the two calls and their ORDER, the way
  // the migration guard in myCars.test.mjs pins its one line and where it sits.
  //
  // The close itself is not something the blur can be left to do. A chip that
  // takes no focus fires no blur at all, and the list then stays open over a
  // field the switch has already rewritten.
  //
  // The order is the half that is easy to get wrong and impossible to see. A
  // close moved to BEFORE the switch banks the Escape value off a field the
  // switch has not written yet, so Escape then puts back the car the user just
  // left.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const start = src.indexOf('$("myCarsRow").addEventListener("click"');
  assert.notEqual(start, -1, "the chip row's click handler moved or was renamed");
  const handler = src.slice(start, src.indexOf("\n  });", start));

  const switched = handler.indexOf("switchToMyCar(");
  const closed = handler.indexOf("hideCarResults()");
  assert.notEqual(switched, -1, "the chip row stopped switching cars");
  assert.notEqual(closed, -1, "a chip switch leaves the picker open again");
  assert.ok(switched < closed, "the picker closes before the switch has settled the field, so Escape banks the old car");
});

test("source guard: both sides of the picker's open/close pair move the list actions", () => {
  // H-3. #carResults is absolutely positioned over .my-cars__actions, so with
  // the list open elementFromPoint at the Add button's centre answered with the
  // "My own car" row, and a tap there picked a car instead of saving one.
  // Nothing in this suite can open a list, so what holds the fix is that BOTH
  // sides say so: a hide with no matching show strands the controls off screen,
  // and one close path left out is the whole defect back for that path alone.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const bodyOf = (name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} moved or was renamed`);
    return src.slice(start, src.indexOf("\n}", start));
  };

  assert.match(bodyOf("renderCarResults"), /paintCarListActions\(true\)/, "opening the picker leaves the actions under it");
  assert.match(bodyOf("hideCarResults"), /paintCarListActions\(false\)/, "closing the picker leaves the actions off screen");

  // Routing through those two is what covers the five close paths. Every one of
  // them ends in hideCarResults, so no path can be missed by listing them, and
  // a close bolted onto a handler instead would be the sixth one that was.
  const closers = src.split("\n").filter((l) =>
    l.includes("hideCarResults") && !l.trim().startsWith("//") && !l.includes("function hideCarResults"));
  assert.ok(closers.length >= 5, `a close path stopped going through hideCarResults: ${closers.length} call sites left`);

  const paint = bodyOf("paintCarListActions");
  assert.match(paint, /showsCarListActions\(/, "the row's visibility stopped being a rule this suite can read");

  // ONE WRITER PER FLAG. renderMyCars owns `hidden` on the two BUTTONS; this
  // owns it on the ROW around them. Reaching for a button's own flag from here
  // is two writers of one flag, which is exactly how the remove control's focus
  // fallback came to read a value nothing ever set.
  assert.ok(!paint.includes("addCarBtn"), "the picker writes the add control's own hidden flag");
  assert.ok(!paint.includes("removeCarBtn"), "the picker writes the remove control's own hidden flag");
  const painter = bodyOf("renderMyCars");
  assert.match(painter, /add\.hidden = /, "renderMyCars stopped owning the add control's flag");
  assert.match(painter, /\$\("removeCarBtn"\)\.hidden = /, "renderMyCars stopped owning the remove control's flag");
  assert.ok(!painter.includes("myCarsActions"), "renderMyCars is a second writer of the row the picker owns");

  // And hiding the row must not leave a keyboard user standing on it. [hidden]
  // is display:none here, and focus on a display:none element goes to <body>.
  assert.match(paint, /activeElement/, "focus can be stranded on the row the next line takes away");
  assert.match(paint, /\$\("carSearch"\)\.focus\(\)/, "focus leaves the row for somewhere other than the field that opened the list");
});

test("source guard: focus alone does not open the picker", () => {
  // The other half of H-3's fix, and the regression it caused. Hiding the row
  // took Add and Remove out of the tab order, so a bare `focus` open meant that
  // merely TABBING THROUGH the field removed both controls before Tab could
  // reach them: the forward walk went carSearch straight to "Adjust details".
  //
  // A click is the gesture that used to arrive wrapped inside focus, and it
  // fires on tap as well, so the mouse and touch paths are unchanged.
  const src = readFileSync(new URL("../js/main.js", import.meta.url), "utf8");
  const start = src.indexOf('$("carSearch").addEventListener("focus"');
  assert.notEqual(start, -1, "the search field's focus handler moved or was renamed");
  const handler = src.slice(start, src.indexOf("\n  });", start));
  assert.ok(
    !handler.includes("renderCarResults"),
    "focus opens the picker again, so a Tab passing through hides Add and Remove out of the tab order",
  );

  // Focus still has to bank the Escape value, and still before any open.
  assert.match(handler, /carRestoreValue = /, "focus stopped banking the value Escape puts back");

  // And all three gestures that DO open it stay wired, or the field goes dead.
  assert.match(src, /\$\("carSearch"\)\.addEventListener\("click"/, "a click no longer opens the list");
  assert.match(src, /\$\("carSearch"\)\.addEventListener\("input"/, "typing no longer opens or filters the list");
  const keydown = src.indexOf('$("carSearch").addEventListener("keydown"');
  assert.notEqual(keydown, -1, "the search field's keydown handler moved or was renamed");
  assert.match(
    src.slice(keydown, src.indexOf("\n  });", keydown)),
    /if \(closed\) renderCarResults\(/,
    "an arrow key on a closed list no longer opens it",
  );
});

test("source guard: the empty my-cars note stays in the accessibility tree", () => {
  // The note used to collapse under `:empty { display: none }`, which takes an
  // element out of the accessibility tree: the region and its first message
  // then arrive in the same frame, which is the case a screen reader is least
  // reliable about reading out. Putting that line back leaves the suite green.
  //
  // The ban names the properties that take an element out of the tree rather
  // than the clip-path recipe that keeps it in, so swapping one visually-hidden
  // shape for an equivalent one stays allowed.
  const css = readFileSync(new URL("../css/styles.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, ""); // the rationale comment quotes the banned line
  const rules = [...css.matchAll(/\.my-cars__note[^{]*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(rules.length, "the note lost its styles entirely, so nothing keeps it out of the layout");
  for (const rule of rules) {
    assert.doesNotMatch(
      rule,
      /display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden/,
      `this takes the note out of the accessibility tree: ${rule.replace(/\s+/g, " ").trim()}`,
    );
  }

  // And the markup must not do it either: `hidden` is display:none by another
  // name, and a live region added at the moment it speaks is one that often
  // does not.
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const note = html.split("\n").find((l) => l.includes('id="myCarsNote"'));
  assert.ok(note, "the note moved or was renamed");
  assert.match(note, /aria-live/, "the note stopped being a live region");
  assert.doesNotMatch(note, /\shidden[\s>]/, "the note is hidden in the markup, which is display:none by another name");
});
