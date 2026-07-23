// theme.test.mjs - assertions for theme resolution. Run with: node --test

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveTheme, nextThemeMode, isNight, THEME_MODES } from "../js/theme.js";

const at = (hour) => new Date(2026, 0, 1, hour, 0, 0);

test("explicit modes ignore the time of day", () => {
  assert.equal(resolveTheme("light", at(23)), "light");
  assert.equal(resolveTheme("dark", at(9)), "dark");
});

test("auto follows local time (dark 19:00-06:59)", () => {
  assert.equal(resolveTheme("auto", at(9)), "light");   // mid-morning
  assert.equal(resolveTheme("auto", at(13)), "light");  // midday
  assert.equal(resolveTheme("auto", at(18)), "light");  // 6pm, still light
  assert.equal(resolveTheme("auto", at(19)), "dark");   // 7pm, night begins
  assert.equal(resolveTheme("auto", at(23)), "dark");   // late evening
  assert.equal(resolveTheme("auto", at(3)), "dark");    // small hours
  assert.equal(resolveTheme("auto", at(6)), "dark");    // 6am, still night
  assert.equal(resolveTheme("auto", at(7)), "light");   // 7am, day begins
});

test("isNight matches the night window boundaries", () => {
  assert.equal(isNight(at(19)), true);
  assert.equal(isNight(at(6)), true);
  assert.equal(isNight(at(7)), false);
  assert.equal(isNight(at(18)), false);
});

test("nextThemeMode cycles auto -> light -> dark -> auto", () => {
  assert.equal(nextThemeMode("auto"), "light");
  assert.equal(nextThemeMode("light"), "dark");
  assert.equal(nextThemeMode("dark"), "auto");
  assert.deepEqual(THEME_MODES, ["auto", "light", "dark"]);
});
