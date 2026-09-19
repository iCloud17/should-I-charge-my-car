// ui.js - the presentation layer's small helpers: DOM lookup, formatting, and
// the pure interaction rules behind the widgets (which arrow key moves where,
// what Enter does).
//
// No charging math and no persistence: those are calc.js and storage.js, and
// nothing here should grow an opinion about break-even, fees or verdicts.
//
// Several of these touch no DOM at all - parseNum, money, formatDuration,
// nextOptionIndex, enterAction. That's deliberate, not a sign they're in the
// wrong file: they are rules about what the user sees and what a keystroke
// does, written as a value in and a value out so the whole module can be tested
// under node with no document.

export const $ = (id) => document.getElementById(id);

export function parseNum(value) {
  if (value == null) return NaN;
  // Forgive a leading currency symbol / whitespace, but do NOT guess through
  // stray characters: "$3,89" and "1.000,50" are fine, "12x3" and "3.8.9" are
  // not a number and return NaN (so the field clears rather than silently
  // becoming 123 / 3.8).
  let s = String(value).trim().replace(/^[$€£¥\s]+/, "");
  if (!/^-?[\d.,]+$/.test(s)) return NaN; // digits + separators only
  // Whichever separator appears last is the decimal point; the other is a
  // thousands grouping. This lets decimal-comma locales enter prices.
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(/,/g, ".");
  else s = s.replace(/,/g, "");
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(s)) return NaN; // exactly one decimal point
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 0 ? n : NaN; // positive-only (0 and above)
}

export function money(value, currency = "$", digits = 2) {
  if (!Number.isFinite(value)) return "-";
  const fixed = value.toFixed(digits);
  // toFixed switches to exponential for |value| >= 1e21; fall back to a plain
  // grouped number so the UI never shows "$1e+60".
  if (fixed.includes("e") || fixed.includes("E")) {
    return `${currency}${Math.round(value).toLocaleString("en-US")}`;
  }
  return `${currency}${fixed}`;
}

// Escape a string for safe interpolation into innerHTML templates.
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "-";
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

// Arrow-key movement for a listbox, as a value in and a value out so it can be
// tested without a DOM. `current` is the active option's index, or -1 for
// "nothing active yet", which is the state a combobox sits in while the caret is
// still in the text field. Both ends wrap, so the last car in a 441-row list is
// one ArrowUp away instead of 440 ArrowDowns.
export function nextOptionIndex(current, count, key) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  const at = Number.isInteger(current) && current >= 0 && current < count ? current : -1;
  if (key === "ArrowDown") return at === -1 || at === count - 1 ? 0 : at + 1;
  if (key === "ArrowUp") return at <= 0 ? count - 1 : at - 1;
  return at;
}

// What Enter does in that same listbox, again as values in and a value out so
// the rule can be tested without a DOM. "commit" takes the active option.
// "close" dismisses a list the user can see but has nothing active in, which is
// every soft keyboard: phones send no arrow keys, so activeIndex never leaves
// -1 and Enter would otherwise be a dead key over an open list. "ignore" hands
// the key back to the page when the list is not showing.
export function enterAction(expanded, activeIndex) {
  if (!expanded) return "ignore";
  return Number.isInteger(activeIndex) && activeIndex >= 0 ? "commit" : "close";
}
