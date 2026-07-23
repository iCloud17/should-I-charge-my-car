// ui.js - small DOM/formatting helpers. No business logic here.

export const $ = (id) => document.getElementById(id);

export function parseNum(value) {
  if (value == null) return NaN;
  const n = parseFloat(String(value).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

export function money(value, currency = "$", digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return `${currency}${value.toFixed(digits)}`;
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
