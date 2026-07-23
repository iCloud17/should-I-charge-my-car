// ui.js — small DOM/formatting helpers. No business logic here.

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

// Animate a number in an element from its current value to a new target.
export function animateValue(el, to, { currency = "$", digits = 2, duration = 350 } = {}) {
  const from = el._val ?? to;
  el._val = to;
  if (!Number.isFinite(to)) {
    el.textContent = "-";
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const v = from + (to - from) * eased;
    el.textContent = `${currency}${v.toFixed(digits)}`;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
