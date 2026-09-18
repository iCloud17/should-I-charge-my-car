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
// preset's CAPPED value, so Level 2 still highlights on a car whose onboard
// charger tops out below 6.6 kW (clicking the preset caps it the same way).
export function presetMatchesKw(fieldKw, presetKw, car) {
  const effective = chargeDrawKw(presetKw, car);
  return Number.isFinite(fieldKw) && Number.isFinite(effective) && Math.abs(effective - fieldKw) < 0.05;
}
