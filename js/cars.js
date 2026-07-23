// cars.js - load the bundled PHEV dataset and expose lookup helpers.

let cars = [];

export async function loadCars() {
  try {
    const res = await fetch("data/phevs.json", { cache: "no-cache" });
    const json = await res.json();
    cars = Array.isArray(json.cars) ? json.cars : [];
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
