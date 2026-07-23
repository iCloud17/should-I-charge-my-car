// calc.js - pure math. No DOM, no globals. All inputs are pre-normalized to
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

/**
 * Available charge power at a given state of charge (SoC), in kW.
 *
 * Batteries don't charge linearly: power is roughly flat up to a "knee" SoC
 * (constant-power / CC phase), then tapers as the BMS switches to constant
 * voltage (CV phase), so the last portion takes disproportionately longer.
 * Level 2 AC charging holds near full power until roughly 90-95% SoC, so the
 * knee defaults to 92.5%. We model the CV phase as a linear taper from full
 * power at the knee down to
 * `taperEndFactor` * full power at 100%. This is an approximation, but it
 * captures the key effect: topping off to 100% costs lots of time for little
 * energy - which matters when there are per-minute or idle fees.
 */
export function powerAtSoc(soc, powerKw, kneePct = 92.5, taperEndFactor = 0.25) {
  if (soc <= kneePct) return powerKw;
  const t = Math.min(1, (soc - kneePct) / (100 - kneePct)); // 0..1 through CV phase
  return powerKw * (1 - (1 - taperEndFactor) * t);
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
 * The rate for a duration-based tier schedule at a given ELAPSED session time
 * (minutes since plug-in). Tiers are { start, rate } where start is elapsed
 * minutes; a tier applies from its start until the next tier's start. No wrap.
 */
export function rateAtElapsed(tiers, minutes) {
  const s = (tiers || [])
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.rate))
    .sort((a, b) => a.start - b.start);
  if (!s.length) return NaN;
  let current = s[0];
  for (const p of s) {
    if (p.start <= minutes) current = p;
    else break;
  }
  return current.rate;
}

// --- Time-connected fee (charged by the hour while plugged in) --------------
/**
 * Total time-based fee for staying plugged in `minutes`, given tiers
 * [{ start, perHour }] where start is the elapsed connected minute the tier
 * kicks in and perHour is the currency-per-hour rate from that point until the
 * next tier. Example (ChargePoint): first 4 hrs at $2.04/hr, then $5/hr =
 * [{ start: 0, perHour: 2.04 }, { start: 240, perHour: 5 }].
 */
export function timeFeeCost(tiers, minutes) {
  const s = (tiers || [])
    .filter((t) => Number.isFinite(t.start) && Number.isFinite(t.perHour))
    .sort((a, b) => a.start - b.start);
  if (!s.length || !(minutes > 0)) return 0;
  let cost = 0;
  for (let i = 0; i < s.length; i++) {
    const from = Math.max(s[i].start, 0);
    const to = i + 1 < s.length ? s[i + 1].start : Infinity;
    if (minutes <= from) break;
    const spanMin = Math.min(minutes, to) - from; // minutes billed at this tier
    if (spanMin > 0) cost += (spanMin / 60) * s[i].perHour;
  }
  return cost;
}

// --- Unified charge curve ---------------------------------------------------

/**
 * One integration pass over a charging session that answers everything the UI
 * needs about stopping early:
 *  - the partial result if you unplug at `capMinutes` (energy, time, all-in
 *    effective $/kWh, and the SoC you'd reach),
 *  - the full charge time to `targetPct` (the far end of the "charge for" slider),
 *  - the worth-it limit: the longest you can charge while the all-in effective
 *    price still beats `breakeven`.
 *
 * `rateOf(clockMin, elapsedMin)` returns the energy $/kWh at a point in the
 * session (constant for flat pricing). Fees included: a one-time `sessionFee`
 * and a by-the-hour `timeTiers` fee. Everything is billed against energy pulled
 * from the charger, so this matches breakevenKwhPrice.
 */
export function chargeCurve({
  batteryKwh,
  startPct,
  targetPct,
  powerKw,
  rateOf = () => 0,
  sessionFee = 0,
  timeTiers = [],
  breakeven = NaN,
  capMinutes = Infinity,
  startClockMin = 0,
  chargeEfficiency = 0.88,
  kneePct = 92.5,
  taperEndFactor = 0.25,
}) {
  const start = Math.max(0, Math.min(100, startPct));
  const target = Math.max(0, Math.min(100, targetPct));
  const empty = {
    kwhIntoBattery: 0, kwhFromCharger: 0, minutes: 0, soc: start,
    energyCost: 0, timeFee: 0, totalCost: sessionFee, effectivePerKwh: NaN,
    fullMinutes: 0, fullSoc: start, worthLimitMin: 0, worthLimitSoc: start, everWorth: false,
  };
  if (!(target > start) || !(batteryKwh > 0) || !(powerKw > 0)) return empty;

  const stepPct = 0.5;
  const battPerStep = batteryKwh * (stepPct / 100);
  const chargerPerStep = chargeEfficiency > 0 ? battPerStep / chargeEfficiency : battPerStep;
  const capHours = capMinutes / 60;
  const socOf = (kwhInto) => start + (kwhInto / batteryKwh) * 100;

  let kwhIntoBattery = 0, kwhFromCharger = 0, hours = 0, energyCost = 0;
  let snap = null; // partial result at the cap
  let everWorth = false, worthLimitMin = 0, worthLimitSoc = start;

  for (let soc = start; soc < target; soc += stepPct) {
    const frac = Math.min(stepPct, target - soc) / stepPct;
    const p = powerAtSoc(soc, powerKw, kneePct, taperEndFactor);
    const stepHours = (chargerPerStep * frac) / p;
    const elapsedMin = hours * 60;
    const clockMin = (((startClockMin + elapsedMin) % 1440) + 1440) % 1440;
    const rate = rateOf(clockMin, elapsedMin);

    // If the cap lands inside this step, snapshot the partial charge there.
    if (!snap && hours + stepHours >= capHours) {
      const rem = Math.max(0, capHours - hours);
      const f2 = stepHours > 0 ? rem / stepHours : 0;
      const kwhFromCap = kwhFromCharger + chargerPerStep * frac * f2;
      const kwhIntoCap = kwhIntoBattery + battPerStep * frac * f2;
      const energyCap = energyCost + (Number.isFinite(rate) ? rate : 0) * chargerPerStep * frac * f2;
      const timeFeeCap = timeFeeCost(timeTiers, capHours * 60);
      const totalCap = sessionFee + energyCap + timeFeeCap;
      snap = {
        kwhIntoBattery: kwhIntoCap, kwhFromCharger: kwhFromCap, minutes: capHours * 60,
        soc: socOf(kwhIntoCap), energyCost: energyCap, timeFee: timeFeeCap, totalCost: totalCap,
        effectivePerKwh: kwhFromCap > 0 ? totalCap / kwhFromCap : NaN,
      };
    }

    // Advance the full integration by the whole step.
    const kwhStep = chargerPerStep * frac;
    kwhFromCharger += kwhStep;
    energyCost += (Number.isFinite(rate) ? rate : 0) * kwhStep;
    kwhIntoBattery += battPerStep * frac;
    hours += stepHours;

    // Track the last elapsed point that still beats gas.
    if (breakeven > 0 && kwhFromCharger > 0) {
      const connectedMin = hours * 60;
      const eff = (sessionFee + energyCost + timeFeeCost(timeTiers, connectedMin)) / kwhFromCharger;
      if (eff <= breakeven) { everWorth = true; worthLimitMin = connectedMin; worthLimitSoc = socOf(kwhIntoBattery); }
    }
  }

  const fullMinutes = hours * 60;
  const fullTimeFee = timeFeeCost(timeTiers, fullMinutes);
  const fullTotal = sessionFee + energyCost + fullTimeFee;
  const full = {
    kwhIntoBattery, kwhFromCharger, minutes: fullMinutes, soc: target,
    energyCost, timeFee: fullTimeFee, totalCost: fullTotal,
    effectivePerKwh: kwhFromCharger > 0 ? fullTotal / kwhFromCharger : NaN,
  };
  const display = snap || full; // cap beyond the full charge → show the full charge
  return { ...display, fullMinutes, fullSoc: target, worthLimitMin, worthLimitSoc, everWorth };
}
