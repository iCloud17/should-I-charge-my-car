// calc.js — pure math. No DOM, no globals. All inputs are pre-normalized to
// canonical units by units.js: distance = miles, energy = kWh, volume = gallons,
// gas price = currency per gallon, electricity price = currency per kWh.

/**
 * The core number: the highest electricity price ($/kWh) at which charging still
 * costs the same per mile as burning gasoline. Pay less than this → charging wins.
 *
 *   gas cost/mile = gasPrice / mpg
 *   elec cost/mile = pricePerKwh / miPerKwh
 *   set equal  →  pricePerKwh = gasPrice * (miPerKwh / mpg)
 */
export function breakevenKwhPrice({ gasPrice, mpg, miPerKwh }) {
  if (!(mpg > 0) || !(miPerKwh > 0) || !(gasPrice >= 0)) return NaN;
  return gasPrice * (miPerKwh / mpg);
}

/** Cost to drive one mile on gasoline. */
export function gasCostPerMile({ gasPrice, mpg }) {
  if (!(mpg > 0)) return NaN;
  return gasPrice / mpg;
}

/** Cost to drive one mile on electricity at a given $/kWh. */
export function elecCostPerMile({ pricePerKwh, miPerKwh }) {
  if (!(miPerKwh > 0)) return NaN;
  return pricePerKwh / miPerKwh;
}

/**
 * Energy and time for a charging session from startPct to targetPct.
 * chargeEfficiency accounts for AC→battery losses (~0.88 typical).
 */
export function chargeSession({ batteryKwh, startPct, targetPct, powerKw, chargeEfficiency = 0.88 }) {
  const span = Math.max(0, (targetPct - startPct) / 100);
  const energyIntoBattery = batteryKwh * span; // kWh stored
  const kwhFromCharger = chargeEfficiency > 0 ? energyIntoBattery / chargeEfficiency : energyIntoBattery;
  const hours = powerKw > 0 ? kwhFromCharger / powerKw : NaN;
  return {
    kwhIntoBattery: energyIntoBattery,
    kwhFromCharger,
    hours,
    minutes: hours * 60,
  };
}

/**
 * Effective all-in price per kWh actually delivered to the battery, including a
 * flat per-session fee, the energy rate, and any idle fee. This is what you
 * compare against breakevenKwhPrice to decide "should I charge here?".
 */
export function effectiveKwhPrice({ sessionFee = 0, ratePerKwh = 0, kwhFromCharger, idleFeePerHour = 0, idleHours = 0 }) {
  if (!(kwhFromCharger > 0)) return NaN;
  const total = sessionFee + ratePerKwh * kwhFromCharger + idleFeePerHour * idleHours;
  return total / kwhFromCharger;
}

/** Simple verdict bucket comparing a price against break-even, with a margin band. */
export function verdict(pricePerKwh, breakeven, marginPct = 0.08) {
  if (!(breakeven > 0) || Number.isNaN(pricePerKwh)) return "unknown";
  const band = breakeven * marginPct;
  if (pricePerKwh <= breakeven - band) return "worth";
  if (pricePerKwh >= breakeven + band) return "gas";
  return "close";
}
