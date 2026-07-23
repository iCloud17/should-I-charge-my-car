// seed.mjs — regenerate data/phevs.json from the fueleconomy.gov bulk dataset.
//
// fueleconomy.gov (US DOE/EPA) is the authority behind window-sticker numbers and
// publishes a free bulk CSV of every rated vehicle. We filter to plug-in hybrids
// and extract exactly the fields the app needs:
//   mpg        = comb08  (combined gasoline MPG, charge-sustaining)
//   miPerKwh   = 100 / combE  (combE is combined electricity use, kWh per 100 mi)
//   evRangeMi  = 0.55*rangeCityA + 0.45*rangeHwyA  (EPA electric-only range)
//   batteryKwh = evRangeMi * combE / 100  (estimated *usable* pack energy)
//
// Usage:  node scripts/seed.mjs            (downloads the CSV if not cached)
//         node scripts/seed.mjs --year 2021 (min model year; default 2021)
//
// Every value is a pre-filled default the user can override in the app.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CSV_URL = "https://www.fueleconomy.gov/feg/epadata/vehicles.csv";
const CSV_CACHE = path.join(__dirname, ".vehicles.cache.csv");
const OUT = path.join(ROOT, "data", "phevs.json");

const MIN_YEAR = Number(argValue("--year") ?? 2021);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

async function getCsv() {
  if (fs.existsSync(CSV_CACHE)) {
    console.log(`Using cached CSV: ${CSV_CACHE}`);
    return fs.readFileSync(CSV_CACHE, "utf8");
  }
  console.log(`Downloading ${CSV_URL} ...`);
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(CSV_CACHE, text);
  console.log(`Cached to ${CSV_CACHE} (${(text.length / 1e6).toFixed(1)} MB)`);
  return text;
}

function round(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

async function main() {
  const text = await getCsv();
  const lines = text.split(/\r?\n/);
  const H = parseLine(lines[0]);
  const idx = (n) => H.indexOf(n);
  const I = {
    atvType: idx("atvType"), make: idx("make"), model: idx("model"), year: idx("year"),
    comb08: idx("comb08"), combE: idx("combE"),
    rangeCityA: idx("rangeCityA"), rangeHwyA: idx("rangeHwyA"),
  };

  // Keep the newest entry per make+model.
  const byKey = new Map();
  for (let k = 1; k < lines.length; k++) {
    if (!lines[k]) continue;
    const f = parseLine(lines[k]);
    if (f[I.atvType] !== "Plug-in Hybrid") continue;

    const year = Number(f[I.year]);
    const mpg = Number(f[I.comb08]);
    const combE = Number(f[I.combE]);
    if (year < MIN_YEAR || !(mpg > 0) || !(combE > 0)) continue;

    const make = f[I.make].trim();
    const model = f[I.model].trim();
    const rangeCityA = Number(f[I.rangeCityA]) || 0;
    const rangeHwyA = Number(f[I.rangeHwyA]) || 0;
    const evRangeMi = round(0.55 * rangeCityA + 0.45 * rangeHwyA, 0);
    const miPerKwh = round(100 / combE, 2);
    const batteryKwh = evRangeMi > 0 ? round((evRangeMi * combE) / 100, 1) : null;

    const key = `${make}|${model}`.toLowerCase();
    const prev = byKey.get(key);
    if (!prev || year > prev.year) {
      byKey.set(key, {
        id: slug(`${make}-${model}-${year}`),
        make, model, year, mpg, miPerKwh,
        batteryKwh, evRangeMi: evRangeMi || null,
      });
    }
  }

  const cars = [...byKey.values()].sort(
    (a, b) => a.make.localeCompare(b.make) || a.model.localeCompare(b.model)
  );

  const output = {
    _source: "US DOE/EPA fueleconomy.gov bulk data (vehicles.csv)",
    _sourceUrl: CSV_URL,
    _generatedAt: new Date().toISOString().slice(0, 10),
    _note:
      "PHEVs (atvType='Plug-in Hybrid'), newest year per model, model year >= " +
      MIN_YEAR + ". mpg=comb08 (gas), miPerKwh=100/combE, evRangeMi from EPA " +
      "electric range, batteryKwh=estimated usable energy. All values user-editable.",
    cars,
  };

  fs.writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n");
  console.log(`Wrote ${cars.length} PHEVs to ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
