// ui.js - small DOM/formatting helpers. No business logic here.

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
