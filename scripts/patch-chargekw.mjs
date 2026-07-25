import fs from "node:fs";
import https from "node:https";

// Reverse-engineer each car's effective AC charge power (chargeKw) from the
// EPA/DOE fueleconomy.gov `charge240` field (official hours to charge at 240 V).
//
// Source (public domain): https://www.fueleconomy.gov/feg/epadata/vehicles.csv
// Field: charge240 = "time to charge an electric vehicle in hours at 240 V".
//
// Method: chargeKw = batteryKwh / charge240 - the effective AC power that moves
// the (usable) battery energy in the EPA-measured time. Validated against known
// nameplate specs, this tracks the sticker value within ~15% for most models
// (EPA's charge240 behaves like a simple energy/power figure, so no extra taper
// correction is applied here - the app's own charge curve adds the near-full
// slowdown on top of this peak). It is the correct peak-power INPUT to the app's
// model, not a tapered average.
//
// Caveat: charge240 is EPA-rounded and batteryKwh is an estimate, so this is an
// approximation of the nameplate peak, not a spec-sheet value. User-editable.

const CSV_URL = "https://www.fueleconomy.gov/feg/epadata/vehicles.csv";
const CSV_PATHS = ["vehicles.csv", "/tmp/vehicles.csv"];
const DATA = "data/phevs.json";

function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
  }
  out.push(cur); return out;
}

function loadCsv() {
  for (const p of CSV_PATHS) if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  return null;
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
      let data = ""; res.setEncoding("utf8");
      res.on("data", (c) => data += c);
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

async function main() {
  let csv = loadCsv();
  if (!csv) { console.log("Downloading EPA vehicles.csv ..."); csv = await download(CSV_URL); }

  const lines = csv.split(/\r?\n/);
  const hdr = parseCsvLine(lines[0]);
  const col = (n) => hdr.indexOf(n);
  const iMake = col("make"), iModel = col("model"), iYear = col("year"), iAtv = col("atvType"), iC240 = col("charge240");

  // First non-zero charge240 per make|model|year (PHEVs only).
  const epa = new Map();
  for (let k = 1; k < lines.length; k++) {
    if (!lines[k]) continue;
    const r = parseCsvLine(lines[k]);
    if (!/Plug-in Hybrid/i.test(r[iAtv] || "")) continue;
    const key = `${r[iMake]}|${r[iModel]}|${r[iYear]}`;
    const t = parseFloat(r[iC240]);
    if (t > 0 && !epa.has(key)) epa.set(key, t);
  }

  const j = JSON.parse(fs.readFileSync(DATA, "utf8"));
  let set = 0, miss = 0;
  for (const c of j.cars) {
    delete c.chargeKw;
    const t = epa.get(`${c.make}|${c.model}|${c.year}`);
    if (!(t > 0) || !(c.batteryKwh > 0)) { miss++; continue; }
    c.chargeKw = Math.round((c.batteryKwh / t) * 10) / 10; // effective AC kW, 1 decimal
    set++;
  }

  j._note = "PHEVs (atvType='Plug-in Hybrid'), every model year >= 2012. mpg=comb08 (gas), miPerKwh=100/combE, evRangeMi from EPA electric range, batteryKwh=estimated usable energy. chargeKw=effective AC charge power (kW) derived as batteryKwh/charge240 from EPA 240V charge hours; see scripts/patch-chargekw.mjs. Approximate (EPA-rounded time, estimated battery), user-editable.";

  fs.writeFileSync(DATA, JSON.stringify(j, null, 2) + "\n");
  console.log(`chargeKw set on ${set}/${j.cars.length} cars (${miss} without EPA charge240 match)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
