import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNum, money } from "../js/ui.js";

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
