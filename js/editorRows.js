// Editor rows for the fee/schedule tiers: time-of-day, by-duration, station
// time, and tax. Each row is one flex line, a leading control, a value field,
// then a delete button. Keeping the markup, the class contract, and the
// read-back parsing in one place makes it the single source of truth for these
// "add another tier" inputs, so every editor is built and read the same way.
import { $, parseNum, escapeHtml } from "./ui.js";
import { createDropdown } from "./dropdown.js";

// --- Field builders (used only by the row builders below) ---
// The currency symbol is passed in rather than read from a global, so the
// caller owns the current currency.
function moneyField(currency, cls, value, placeholder = "0.30") {
  return (
    `<div class="input-money tou-rate-wrap">` +
    `<span class="input-money__sym">${escapeHtml(currency)}</span>` +
    `<input type="text" min="0" step="any" inputmode="decimal" class="${cls}" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}" />` +
    `</div>`
  );
}

// "after <n> <min|hr>" group: a numeric field plus the minutes/hours unit
// picker (a custom dropdown wired per row by wireUnitDropdown), shared by the
// by-duration and station-time tier rows.
function afterField(numExtraCls, numValue, unit) {
  return (
    `<div class="dur-after">after ` +
    `<input type="text" min="0" step="any" inputmode="numeric" class="dur-min ${numExtraCls}" value="${escapeHtml(numValue)}" />` +
    `<span class="row-unit-wrap">` +
    `<button type="button" class="row-unit" aria-haspopup="listbox" aria-expanded="false" aria-label="Tier start unit" data-value="${escapeHtml(unit)}">` +
    `<span class="row-unit__label">${escapeHtml(unit)}</span><span class="row-unit__caret" aria-hidden="true">\u25BE</span>` +
    `</button>` +
    `<ul class="combo__results row-unit-menu" role="listbox" aria-label="Tier start unit" hidden></ul>` +
    `</span>` +
    `</div>`
  );
}

const UNIT_OPTIONS = [{ value: "min", label: "min" }, { value: "hr", label: "hr" }];

// Wire the min/hr picker for one row using the shared dropdown. The chosen unit
// lives on the button's data-value; changing it dispatches an input event so the
// existing row listener re-renders the result.
function wireUnitDropdown(row) {
  const btn = row.querySelector(".row-unit");
  createDropdown({
    trigger: btn,
    menu: row.querySelector(".row-unit-menu"),
    itemClass: "row-unit-item",
    options: () => UNIT_OPTIONS,
    getValue: () => btn.dataset.value,
    onChange: (v) => {
      btn.dataset.value = v;
      btn.querySelector(".row-unit__label").textContent = v;
      btn.dispatchEvent(new Event("input", { bubbles: true }));
    },
  });
}

function deleteButton(label) {
  return `<button type="button" class="tou-del" aria-label="${escapeHtml(label)}">\u00d7</button>`;
}

// --- Row builders (append one row to the matching editor) ---
export function addTouRow(currency, time = "00:00", rate = "") {
  const row = document.createElement("div");
  row.className = "tou-row";
  row.innerHTML =
    `<input type="time" class="tou-time" value="${escapeHtml(time)}" />` +
    moneyField(currency, "tou-rate", rate) +
    deleteButton("Remove period");
  $("touRows").appendChild(row);
}

export function addDurRow(currency, min = 0, rate = "", unit = "min") {
  const row = document.createElement("div");
  row.className = "tou-row dur-row";
  row.innerHTML =
    afterField("", min, unit) +
    moneyField(currency, "dur-rate", rate) +
    deleteButton("Remove tier");
  $("durRows").appendChild(row);
  wireUnitDropdown(row);
}

export function addTimeFeeRow(currency, start = 0, perHour = "", unit = "hr") {
  const row = document.createElement("div");
  row.className = "tou-row tf-row";
  row.innerHTML =
    afterField("tf-start", start, unit) +
    moneyField(currency, "tf-rate", perHour, "3") +
    `<span class="tf-unit">/hr</span>` +
    deleteButton("Remove tier");
  $("timeFeeRows").appendChild(row);
  wireUnitDropdown(row);
}

export function addTaxRow(label = "", pct = "") {
  const row = document.createElement("div");
  row.className = "tou-row tax-row";
  row.innerHTML =
    `<input type="text" class="tax-label" placeholder="Tax name (optional)" value="${escapeHtml(label)}" />` +
    `<div class="input-money has-suffix tax-pct-wrap">` +
    `<input type="text" min="0" step="any" inputmode="decimal" class="tax-pct" placeholder="6.25" value="${escapeHtml(pct)}" />` +
    `<span class="input-money__suffix">%</span>` +
    `</div>` +
    deleteButton("Remove tax");
  $("taxRows").appendChild(row);
}

// --- Row readers (parse the editor rows back into data) ---
// Build the TOU schedule from the editor rows: [{ start(min), rate }].
export function readSchedule() {
  const sched = [];
  for (const r of document.querySelectorAll("#touRows .tou-row")) {
    const t = r.querySelector(".tou-time").value;
    const rate = parseNum(r.querySelector(".tou-rate").value);
    if (!t || !Number.isFinite(rate)) continue;
    const [h, mm] = t.split(":").map(Number);
    sched.push({ start: h * 60 + mm, rate });
  }
  return sched;
}

// Build duration tiers from the editor rows: [{ start(elapsed min), rate }].
// A tier start can be entered in minutes or hours; both normalize to minutes
// here so the pricing math stays in one unit.
export function readDurationTiers() {
  const tiers = [];
  for (const r of document.querySelectorAll("#durRows .dur-row")) {
    const num = parseNum(r.querySelector(".dur-min").value);
    const unit = r.querySelector(".row-unit").dataset.value;
    const rate = parseNum(r.querySelector(".dur-rate").value);
    if (!Number.isFinite(rate)) continue;
    const start = Number.isFinite(num) ? (unit === "hr" ? num * 60 : num) : 0;
    tiers.push({ start, rate });
  }
  return tiers;
}

// Build by-the-hour time-fee tiers from the editor rows: [{ start(min), perHour }].
// Each row's start can be entered in hours (default) or minutes; we normalize to
// minutes here so the math and the rest of the app stay in one unit.
export function readTimeFee() {
  const tiers = [];
  for (const r of document.querySelectorAll("#timeFeeRows .tf-row")) {
    const num = parseNum(r.querySelector(".tf-start").value);
    const unit = r.querySelector(".row-unit").dataset.value; // "hr" | "min"
    const perHour = parseNum(r.querySelector(".tf-rate").value);
    if (!Number.isFinite(perHour) || perHour <= 0) continue;
    const startMin = Number.isFinite(num) ? (unit === "hr" ? num * 60 : num) : 0;
    tiers.push({ start: startMin, perHour });
  }
  return tiers;
}

// Sum every tax row into a single fraction (e.g. 6.25% + 1% + 1% -> 0.0825).
// Applied to the whole bill in chargeCurve, matching how chargers add sales tax
// on top of the listed rate and fees.
export function readTaxRate() {
  let pct = 0;
  for (const r of document.querySelectorAll("#taxRows .tax-row")) {
    const v = parseNum(r.querySelector(".tax-pct").value);
    if (Number.isFinite(v) && v > 0) pct += v;
  }
  return pct / 100;
}
