import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNum, money, nextOptionIndex, enterAction } from "../js/ui.js";

test("parseNum reads a plain dot decimal", () => {
  assert.equal(parseNum("3.89"), 3.89);
  assert.equal(parseNum("0.30"), 0.3);
  assert.equal(parseNum("389"), 389);
});

test("parseNum accepts a decimal comma (comma-locale phones)", () => {
  assert.equal(parseNum("3,89"), 3.89);
  assert.equal(parseNum("0,30"), 0.3);
});

test("parseNum treats the last separator as the decimal, the other as thousands", () => {
  assert.equal(parseNum("1,000.50"), 1000.5); // US grouping
  assert.equal(parseNum("1.000,50"), 1000.5); // EU grouping
});

test("parseNum rejects blanks, negatives, and non-numbers", () => {
  assert.ok(Number.isNaN(parseNum("")));
  assert.ok(Number.isNaN(parseNum("   ")));
  assert.ok(Number.isNaN(parseNum(null)));
  assert.ok(Number.isNaN(parseNum("-5")));
  assert.ok(Number.isNaN(parseNum("abc")));
});

test("parseNum does NOT guess through stray characters or malformed numbers", () => {
  assert.ok(Number.isNaN(parseNum("12x3")));  // not 123
  assert.ok(Number.isNaN(parseNum("3.8.9"))); // not 3.8
  assert.ok(Number.isNaN(parseNum("1a")));
  assert.ok(Number.isNaN(parseNum("6.6 kW")));
});

test("parseNum tolerates a leading currency symbol and surrounding spaces", () => {
  assert.equal(parseNum(" 3,89 "), 3.89);
  assert.equal(parseNum("$3.89"), 3.89);
  assert.equal(parseNum("3."), 3);   // trailing dot mid-typing
  assert.equal(parseNum(".5"), 0.5); // leading dot
});

test("money renders the chosen currency symbol (single- and multi-char)", () => {
  assert.equal(money(3.5, "€"), "€3.50");
  assert.equal(money(0.3, "£"), "£0.30");
  assert.equal(money(12, "Fr"), "Fr12.00");
  assert.equal(money(1.2, "R$"), "R$1.20");
  assert.equal(money(1.2), "$1.20"); // defaults to $
});

test("money returns a dash for non-finite values regardless of symbol", () => {
  assert.equal(money(NaN, "€"), "-");
  assert.equal(money(Infinity, "£"), "-");
});

// --- nextOptionIndex: the arrow-key rules behind the car picker's active row ---

test("nextOptionIndex enters the list from the text field at the near end", () => {
  assert.equal(nextOptionIndex(-1, 5, "ArrowDown"), 0, "down lands on the first row");
  assert.equal(nextOptionIndex(-1, 5, "ArrowUp"), 4, "up lands on the last row");
});

test("nextOptionIndex steps one row at a time", () => {
  assert.equal(nextOptionIndex(0, 5, "ArrowDown"), 1);
  assert.equal(nextOptionIndex(3, 5, "ArrowDown"), 4);
  assert.equal(nextOptionIndex(4, 5, "ArrowUp"), 3);
  assert.equal(nextOptionIndex(1, 5, "ArrowUp"), 0);
});

test("nextOptionIndex wraps at both ends", () => {
  assert.equal(nextOptionIndex(4, 5, "ArrowDown"), 0, "past the last row is the first");
  assert.equal(nextOptionIndex(0, 5, "ArrowUp"), 4, "before the first row is the last");
});

test("nextOptionIndex handles a single option, where wrapping is a no-op", () => {
  assert.equal(nextOptionIndex(-1, 1, "ArrowDown"), 0, "the My own car row alone");
  assert.equal(nextOptionIndex(0, 1, "ArrowDown"), 0);
  assert.equal(nextOptionIndex(0, 1, "ArrowUp"), 0);
});

test("nextOptionIndex reports nothing active when there is nothing to activate", () => {
  for (const count of [0, -1, NaN, undefined, 2.5]) {
    assert.equal(nextOptionIndex(0, count, "ArrowDown"), -1, `count ${count}`);
  }
});

// Typing re-filters the list under the caret, so an index saved before the
// keystroke can point past the end of the new, shorter list.
test("nextOptionIndex treats an out-of-range current index as nothing active", () => {
  assert.equal(nextOptionIndex(9, 3, "ArrowDown"), 0);
  assert.equal(nextOptionIndex(9, 3, "ArrowUp"), 2);
  assert.equal(nextOptionIndex(-4, 3, "ArrowDown"), 0);
});

test("nextOptionIndex leaves the active row alone for keys it does not own", () => {
  assert.equal(nextOptionIndex(2, 5, "Home"), 2, "Home moves the caret, not the list");
  assert.equal(nextOptionIndex(2, 5, "End"), 2);
  assert.equal(nextOptionIndex(2, 5, "a"), 2);
  assert.equal(nextOptionIndex(-1, 5, "Enter"), -1);
});

// --- enterAction: what the Enter/Go/Done key does in the car picker ---

test("enterAction commits the active option", () => {
  assert.equal(enterAction(true, 0), "commit", "the My own car row");
  assert.equal(enterAction(true, 7), "commit");
});

test("enterAction closes an open list that has nothing active", () => {
  // The soft-keyboard case: no arrow key ever ran, so the index is still -1.
  // Before this rule existed the key did nothing at all over a visible list.
  assert.equal(enterAction(true, -1), "close");
});

test("enterAction ignores the key when the list is not showing", () => {
  assert.equal(enterAction(false, -1), "ignore");
  // Closed wins even if a stale index is still sitting around.
  assert.equal(enterAction(false, 3), "ignore", "a closed list has nothing to commit");
});

test("enterAction treats a non-integer active index as nothing active", () => {
  for (const bad of [null, undefined, NaN, 1.5, "2"]) {
    assert.equal(enterAction(true, bad), "close", `activeIndex ${String(bad)}`);
  }
});
