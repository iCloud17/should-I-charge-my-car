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

// --- Time-of-use (TOU) pricing --------------------------------------------

/**
 * The rate in effect at a given minute-of-day for a wrap-around TOU schedule.
 * `schedule` is a non-empty array of { start, rate } where start is minutes from
 * midnight (0..1439). A period runs until the next period's start; the last
 * period wraps past midnight back to the first.
 */
export function rateAtTime(schedule, minute) {
  const s = (schedule || [])
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.rate))
    .sort((a, b) => a.start - b.start);
  if (!s.length) return NaN;
  let current = s[s.length - 1]; // before the first start → previous day's last period
  for (const p of s) {
    if (p.start <= minute) current = p;
    else break;
  }
  return current.rate;
}

/** The cheapest period in a schedule, with its wrap-aware window [start, end). */
export function cheapestPeriod(schedule) {
  const s = (schedule || [])
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.rate))
    .sort((a, b) => a.start - b.start);
  if (!s.length) return null;
  let bestIdx = 0;
  for (let i = 1; i < s.length; i++) if (s[i].rate < s[bestIdx].rate) bestIdx = i;
  const end = s[(bestIdx + 1) % s.length].start;
  return { start: s[bestIdx].start, end, rate: s[bestIdx].rate };
}

/**
 * Integrate a charging session's cost over clock time so a rate change mid-charge
 * (e.g. peak pricing kicking in at 4pm) is billed correctly. `rateOf(minute)`
 * returns the $/kWh at a given minute-of-day. Returns energy cost, all-in total
 * (incl. sessionFee), and the effective $/kWh to compare against break-even.
 */
export function sessionCost({
  batteryKwh,
  startPct,
  targetPct,
  powerKw,
  startClockMin = 0,
  rateOf,
  sessionFee = 0,
  chargeEfficiency = 0.88,
  kneePct = 85,
  taperEndFactor = 0.25,
}) {
  const start = Math.max(0, Math.min(100, startPct));
  const target = Math.max(0, Math.min(100, targetPct));
  const empty = {
    kwhIntoBattery: 0, kwhFromCharger: 0, minutes: 0,
    energyCost: 0, totalCost: sessionFee, effectivePerKwh: NaN,
  };
  if (!(target > start) || !(batteryKwh > 0) || !(powerKw > 0)) return empty;

  const stepPct = 0.5;
  const battPerStep = batteryKwh * (stepPct / 100);
  const chargerPerStep = chargeEfficiency > 0 ? battPerStep / chargeEfficiency : battPerStep;

  let kwhIntoBattery = 0, hours = 0, energyCost = 0;
  for (let soc = start; soc < target; soc += stepPct) {
    const frac = Math.min(stepPct, target - soc) / stepPct;
    const p = powerAtSoc(soc, powerKw, kneePct, taperEndFactor);
    const clockMin = (((startClockMin + hours * 60) % 1440) + 1440) % 1440;
    const rate = rateOf(clockMin);
    const kwhStep = chargerPerStep * frac;
    energyCost += (Number.isFinite(rate) ? rate : 0) * kwhStep;
    kwhIntoBattery += battPerStep * frac;
    hours += (chargerPerStep * frac) / p;
  }

  const kwhFromCharger = chargeEfficiency > 0 ? kwhIntoBattery / chargeEfficiency : kwhIntoBattery;
  const totalCost = sessionFee + energyCost;
  return {
    kwhIntoBattery,
    kwhFromCharger,
    minutes: hours * 60,
    energyCost,
    totalCost,
    effectivePerKwh: kwhFromCharger > 0 ? totalCost / kwhFromCharger : NaN,
  };
}
