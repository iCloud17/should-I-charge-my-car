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
 * Available charge power at a given state of charge (SoC), in kW.
 *
 * Batteries don't charge linearly: power is roughly flat up to a "knee" SoC
 * (constant-power / CC phase), then tapers as the BMS switches to constant
 * voltage (CV phase), so the last portion takes disproportionately longer.
 * We model the CV phase as a linear taper from full power at the knee down to
 * `taperEndFactor` * full power at 100%. This is an approximation, but it
 * captures the key effect: topping off to 100% costs lots of time for little
 * energy — which matters when there are per-minute or idle fees.
 */
export function powerAtSoc(soc, powerKw, kneePct = 85, taperEndFactor = 0.25) {
  if (soc <= kneePct) return powerKw;
  const t = Math.min(1, (soc - kneePct) / (100 - kneePct)); // 0..1 through CV phase
  return powerKw * (1 - (1 - taperEndFactor) * t);
}

/**
 * Energy and time for a charging session from startPct to targetPct.
 * chargeEfficiency accounts for AC→battery losses (~0.88 typical).
 * Time is integrated over SoC using a non-linear CC-CV power curve, so the
 * final top-off takes realistically longer than the bulk of the charge.
 */
export function chargeSession({
  batteryKwh,
  startPct,
  targetPct,
  powerKw,
  chargeEfficiency = 0.88,
  kneePct = 85,
  taperEndFactor = 0.25,
}) {
  const start = Math.max(0, Math.min(100, startPct));
  const target = Math.max(0, Math.min(100, targetPct));
  if (!(target > start) || !(batteryKwh > 0) || !(powerKw > 0)) {
    return { kwhIntoBattery: 0, kwhFromCharger: 0, hours: 0, minutes: 0 };
  }

  const stepPct = 0.5;
  const battPerStep = batteryKwh * (stepPct / 100); // kWh stored per step
  const chargerPerStep = chargeEfficiency > 0 ? battPerStep / chargeEfficiency : battPerStep;

  let kwhIntoBattery = 0;
  let hours = 0;
  for (let soc = start; soc < target; soc += stepPct) {
    const frac = Math.min(stepPct, target - soc) / stepPct; // handle final partial step
    const p = powerAtSoc(soc, powerKw, kneePct, taperEndFactor);
    kwhIntoBattery += battPerStep * frac;
    hours += (chargerPerStep * frac) / p;
  }

  const kwhFromCharger = chargeEfficiency > 0 ? kwhIntoBattery / chargeEfficiency : kwhIntoBattery;
  return { kwhIntoBattery, kwhFromCharger, hours, minutes: hours * 60 };
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
