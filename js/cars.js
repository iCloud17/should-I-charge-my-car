// cars.js - load the bundled PHEV dataset and expose lookup helpers.

let cars = [];

export async function loadCars() {
  try {
    const res = await fetch("data/phevs.json", { cache: "no-cache" });
    const json = await res.json();
    const list = Array.isArray(json.cars) ? json.cars : [];
    // Sort by name (make, then model), then newest year first.
    list.sort((a, b) => a.make.localeCompare(b.make) || a.model.localeCompare(b.model) || b.year - a.year);
    cars = list;
  } catch {
    cars = [];
  }
  return cars;
}

export function getCars() {
  return cars;
}

export function getCar(id) {
  return cars.find((c) => c.id === id) || null;
}

export function carLabel(car) {
  return `${car.year} ${car.make} ${car.model}`;
}

// Longest "year make model" label length, used to cap the search field.
export function maxLabelLength() {
  let max = 0;
  for (const c of cars) { const n = carLabel(c).length; if (n > max) max = n; }
  return max;
}

// --- Charge power: what the CAR accepts vs what the OUTLET supplies ---

// The car's onboard-charger ceiling: its rated max, else no limit (a custom car,
// or one the dataset has no figure for).
//
// This is a property of the CAR and nothing else, which is why it takes only a
// car. Saved prefs still carry a legacy per-car powerKw, and reading that here
// turned "the outlet I used with this car once" into a permanent cap on the car.
// Any extra context handed to this function must leave the answer unchanged.
export function carCeilingKw(car) {
  if (car && Number.isFinite(car.chargeKw)) return car.chargeKw;
  return Infinity;
}

// The AC ceiling the estimate prices against: three-phase 400 V / 32 A, the
// common IEC 62196 Type 2 top end, above the 19.2 kW J1772 single-phase maximum.
//
// Not a claim about what the cars accept. Some PHEVs do take DC (the Mitsubishi
// Outlander PHEV in this dataset has a CHAdeMO port), so "PHEVs are AC only"
// would be wrong as a blanket statement. It changes nothing here: every chargeKw
// in the dataset is an onboard AC figure and the highest is 11.2 kW, so for a
// known car carCeilingKw binds long before this constant does. The onboard
// charger is what bounds these vehicles, not a rule about wall current.
//
// A fixed constant on purpose. It states a fact about the outlet, not about
// whichever car is selected, so unlike the car-derived cap that used to be
// written into prefs it has nothing to ratchet down to.
//
// 22 is the common ceiling, not an absolute one: 63 A three-phase Type 2 reaches
// 43 kW, rare and largely retired. A higher figure holds for the session and is
// priced at no more than 22, then storage.js drops it on the next load and the
// field comes back at the 6.6 default.
export const MAX_OUTLET_KW = 22;

// What the car actually pulls from an outlet: the outlet's rate, capped by
// physics and then by the car's onboard charger. Derive this at the point of
// use and never write it back into storage - a stored cap only ever ratchets
// down, so one low-power car would pin the field there for every car chosen
// afterwards.
//
// This is also the only bound on a custom car, whose carCeilingKw is Infinity.
// Bounding here rather than in the input field is deliberate: the field holds
// what the user is typing, and rewriting digits mid-keystroke fights them. The
// estimate is where an absurd number turns into an authoritative-looking answer,
// so that is where it gets bounded.
export function chargeDrawKw(outletKw, car) {
  return Math.min(outletKw, MAX_OUTLET_KW, carCeilingKw(car));
}

// Does a charger-speed preset match what's in the power field? Compared at the
// preset's own RAW value, because the field holds the OUTLET and tapping a
// preset writes the number on its label unchanged. So Level 2 lights up on a
// 6.6 kW field for every car, including one whose onboard charger tops out at
// 1.7 - the button describes the outlet you're plugged into, not the car.
//
// The car is deliberately not a parameter: it cannot change the answer. Capping
// here would re-link the highlight to the ceiling and leave nothing selected on
// any car rated below 6.6, which is most of the dataset at the default field
// value. The cap still applies where it is physically true, at chargeDrawKw in
// the estimate, so a 1.7 kW car shows Level 2 lit and "at 1.7 kW" together.
export function presetMatchesKw(fieldKw, presetKw) {
  return Number.isFinite(fieldKw) && Number.isFinite(presetKw) && Math.abs(presetKw - fieldKw) < 0.05;
}
