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

// What the car actually pulls from an outlet: the outlet's rate, capped by the
// car's onboard charger. Derive this at the point of use and never write it back
// into storage - a stored cap only ever ratchets down, so one low-power car
// would pin the field there for every car chosen afterwards.
export function chargeDrawKw(outletKw, car) {
  return Math.min(outletKw, carCeilingKw(car));
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
