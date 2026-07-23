// units.js — convert AT THE EDGES, compute in canonical units.
// Canonical: distance = miles, energy = kWh, volume = gallons,
// fuel economy = MPG, EV efficiency = mi/kWh, gas price = $/gallon.

export const LITERS_PER_GALLON = 3.785411784;
export const KM_PER_MILE = 1.609344;

// --- Fuel economy -----------------------------------------------------------
// Imperial input: MPG (already canonical). Metric input: L/100km.
export function mpgFromL100km(l100km) {
  return l100km > 0 ? 235.214583 / l100km : NaN;
}
export function l100kmFromMpg(mpg) {
  return mpg > 0 ? 235.214583 / mpg : NaN;
}

// --- EV efficiency ----------------------------------------------------------
// Imperial input: mi/kWh (canonical). Metric input: kWh/100km.
export function miPerKwhFromKwh100km(kwh100km) {
  return kwh100km > 0 ? 62.137119 / kwh100km : NaN;
}
export function kwh100kmFromMiPerKwh(miPerKwh) {
  return miPerKwh > 0 ? 62.137119 / miPerKwh : NaN;
}

// --- Gas price --------------------------------------------------------------
// Imperial input: price per gallon (canonical). Metric input: price per liter.
export function perGallonFromPerLiter(perLiter) {
  return perLiter * LITERS_PER_GALLON;
}
export function perLiterFromPerGallon(perGallon) {
  return perGallon / LITERS_PER_GALLON;
}

// --- Distance ---------------------------------------------------------------
export function milesFromKm(km) {
  return km / KM_PER_MILE;
}
export function kmFromMiles(mi) {
  return mi * KM_PER_MILE;
}

// Unit labels for the current system.
export function labels(system) {
  const metric = system === "metric";
  return {
    fuelEconomy: metric ? "L/100km" : "MPG",
    evEfficiency: metric ? "kWh/100km" : "mi/kWh",
    gasVolume: metric ? "per liter" : "per gallon",
    distance: metric ? "km" : "mi",
  };
}

// Convert a canonical car record's fuel-economy / efficiency values into the
// numbers to SHOW in the current unit system's input fields.
export function economyForDisplay(mpg, system) {
  return system === "metric" ? l100kmFromMpg(mpg) : mpg;
}
export function efficiencyForDisplay(miPerKwh, system) {
  return system === "metric" ? kwh100kmFromMiPerKwh(miPerKwh) : miPerKwh;
}

// Convert user-entered display values back to canonical for the math.
export function economyToCanonical(value, system) {
  return system === "metric" ? mpgFromL100km(value) : value;
}
export function efficiencyToCanonical(value, system) {
  return system === "metric" ? miPerKwhFromKwh100km(value) : value;
}
export function gasPriceToCanonical(value, system) {
  return system === "metric" ? perGallonFromPerLiter(value) : value;
}
export function gasPriceForDisplay(perGallon, system) {
  return system === "metric" ? perLiterFromPerGallon(perGallon) : perGallon;
}
