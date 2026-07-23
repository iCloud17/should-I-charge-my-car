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
