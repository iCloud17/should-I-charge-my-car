// units.js - convert AT THE EDGES, compute in canonical units.
// Canonical: distance = miles, energy = kWh, volume = gallons,
// fuel economy = MPG, EV efficiency = mi/kWh, gas price = $/gallon.

export const LITERS_PER_GALLON = 3.785411784;      // US gallon
export const LITERS_PER_IMP_GALLON = 4.54609;      // UK imperial gallon
export const KM_PER_MILE = 1.609344;
// Canonical fuel economy is US MPG. The imperial gallon is larger, so the same
// car reads ~20% more miles per (imperial) gallon: mpg_imp = mpg_us * this.
export const IMP_PER_US_MPG = LITERS_PER_IMP_GALLON / LITERS_PER_GALLON;

// --- Fuel economy -----------------------------------------------------------
// US input: MPG (canonical). Metric input: L/100km. UK input: MPG (imperial).
export function mpgFromL100km(l100km) {
  return l100km > 0 ? 235.214583 / l100km : NaN;
}
export function l100kmFromMpg(mpg) {
  return mpg > 0 ? 235.214583 / mpg : NaN;
}
// UK imperial-gallon MPG <-> canonical US MPG.
export function impMpgFromUsMpg(mpgUs) {
  return mpgUs > 0 ? mpgUs * IMP_PER_US_MPG : NaN;
}
export function usMpgFromImpMpg(mpgImp) {
  return mpgImp > 0 ? mpgImp / IMP_PER_US_MPG : NaN;
}
// km/L (distance per litre) <-> canonical US MPG. Used by India / Japan / Korea.
export function kmPerLFromMpg(mpgUs) {
  return mpgUs > 0 ? mpgUs * KM_PER_MILE / LITERS_PER_GALLON : NaN;
}
export function mpgFromKmPerL(kmPerL) {
  return kmPerL > 0 ? kmPerL * LITERS_PER_GALLON / KM_PER_MILE : NaN;
}

// --- EV efficiency ----------------------------------------------------------
// Imperial input: mi/kWh (canonical). Metric input: kWh/100km.
export function miPerKwhFromKwh100km(kwh100km) {
  return kwh100km > 0 ? 62.137119 / kwh100km : NaN;
}
export function kwh100kmFromMiPerKwh(miPerKwh) {
  return miPerKwh > 0 ? 62.137119 / miPerKwh : NaN;
}
// km/kWh (distance per kWh) <-> canonical mi/kWh. Japan's denpi is km/kWh; it
// pairs with km/L's distance-per-unit framing.
export function kmPerKwhFromMiPerKwh(mi) {
  return mi > 0 ? mi * KM_PER_MILE : NaN;
}
export function miPerKwhFromKmPerKwh(km) {
  return km > 0 ? km / KM_PER_MILE : NaN;
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
  if (system === "metric") {
    return { fuelEconomy: "L/100km", evEfficiency: "kWh/100km", gasVolume: "liter", distance: "km" };
  }
  if (system === "kmL") {
    // India / Japan / Korea: km per litre, and km/kWh (denpi) for EV efficiency.
    return { fuelEconomy: "km/L", evEfficiency: "km/kWh", gasVolume: "liter", distance: "km" };
  }
  if (system === "uk") {
    // UK rates economy in imperial-gallon MPG but buys fuel by the litre.
    return { fuelEconomy: "MPG", evEfficiency: "mi/kWh", gasVolume: "liter", distance: "mi" };
  }
  return { fuelEconomy: "MPG", evEfficiency: "mi/kWh", gasVolume: "gallon", distance: "mi" };
}

// Convert a canonical car record's fuel-economy / efficiency values into the
// numbers to SHOW in the current unit system's input fields.
export function economyForDisplay(mpg, system) {
  if (system === "metric") return l100kmFromMpg(mpg);
  if (system === "kmL") return kmPerLFromMpg(mpg);
  if (system === "uk") return impMpgFromUsMpg(mpg);
  return mpg;
}
export function efficiencyForDisplay(miPerKwh, system) {
  if (system === "metric") return kwh100kmFromMiPerKwh(miPerKwh);
  if (system === "kmL") return kmPerKwhFromMiPerKwh(miPerKwh);
  return miPerKwh;
}

// Convert user-entered display values back to canonical for the math.
export function economyToCanonical(value, system) {
  if (system === "metric") return mpgFromL100km(value);
  if (system === "kmL") return mpgFromKmPerL(value);
  if (system === "uk") return usMpgFromImpMpg(value);
  return value;
}
export function efficiencyToCanonical(value, system) {
  if (system === "metric") return miPerKwhFromKwh100km(value);
  if (system === "kmL") return miPerKwhFromKmPerKwh(value);
  return value;
}
// UK and metric both price fuel per liter; only US (imperial) prices per gallon.
export function gasPriceToCanonical(value, system) {
  return system === "imperial" ? value : perGallonFromPerLiter(value);
}
export function gasPriceForDisplay(perGallon, system) {
  // Preserve a non-finite (unset) price so it renders blank, not a divided-down 0.
  if (!Number.isFinite(perGallon)) return perGallon;
  return system === "imperial" ? perGallon : perLiterFromPerGallon(perGallon);
}
