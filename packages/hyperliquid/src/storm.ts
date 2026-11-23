import type { AccountRisk } from "./account";

/** Lifeline's rules for one storm: what a vault policy would hold, in USD. */
export type StormPlan = { trigger: number; target: number; perRescueUsd: number; perDayUsd: number; reserveUsd: number; flatFeeUsd: number };
export type StormRescue = { atPct: number; sentUsd: number; landedUsd: number; healthBefore: number; healthAfter: number };
export type StormPoint = { pct: number; without: number; with: number };
export type Storm = {
  points: StormPoint[];
  /** The move, in percent, that liquidates the account; null when none within the range does. */
  diesWithout: number | null;
  diesWith: number | null;
  rescues: StormRescue[];
  spentUsd: number;
};

const STEP_PCT = 0.25;
const SPREAD = 0.00011; // 1Click's, as measured on 2026-11-06
const MAX_RESCUES = 500; // a tiny cap on a huge account would otherwise never finish
const MIN_RESCUE_USD = 2; // 1Click rejects less

/** Health after every covered coin (or just one) moves by `pct`, with `added` USD of margin put in. */
export function healthAfter(risk: AccountRisk, pct: number, coin: string | null = null, added = 0): number {
  let value = risk.value + added;
  let maintenance = 0;
  for (const p of risk.covered) {
    const move = coin === null || p.coin === coin ? pct / 100 : 0;
    value += p.size * p.markPx * move;
    maintenance += Math.abs(p.size) * p.markPx * (1 + move) * p.maintenanceRate;
  }
  return maintenance <= 0 ? Number.POSITIVE_INFINITY : value / maintenance;
}

/**
 * Walks prices from here to `toPct` and rescues on the way, by the keeper's sizing rule.
 * It's an estimate: coins move together, each keeps its current margin tier, there's no
 * funding, and prices fall slowly enough for every rescue to land and every cooldown to pass.
 */
export function storm(risk: AccountRisk, toPct: number, plan: StormPlan, coin: string | null = null): Storm {
  const steps = Math.ceil(Math.abs(toPct) / STEP_PCT);
  const result: Storm = { points: [], diesWithout: null, diesWith: null, rescues: [], spentUsd: 0 };
  let added = 0;
  for (let i = 0; i <= steps; i += 1) {
    const pct = i === steps ? toPct : Math.sign(toPct) * i * STEP_PCT;
    const without = healthAfter(risk, pct, coin);
    if (result.diesWithout === null && without <= 1) result.diesWithout = pct;
    let health = healthAfter(risk, pct, coin, added);
    if (result.diesWith === null && health <= 1) result.diesWith = pct;
    while (result.diesWith === null && health < plan.trigger && result.rescues.length < MAX_RESCUES) {
      const perDollar = (healthAfter(risk, pct, coin, added + 1) - health) || 1; // 1 ÷ maintenance
      const needed = (plan.target - health) / perDollar;
      const sent = Math.min((needed + plan.flatFeeUsd) * 1.01, plan.perRescueUsd, plan.perDayUsd - result.spentUsd, plan.reserveUsd - result.spentUsd);
      if (sent < MIN_RESCUE_USD) break;
      const landed = sent - plan.flatFeeUsd - sent * SPREAD;
      const before = health;
      added += landed;
      result.spentUsd += sent;
      health = healthAfter(risk, pct, coin, added);
      result.rescues.push({ atPct: pct, sentUsd: sent, landedUsd: landed, healthBefore: before, healthAfter: health });
    }
    result.points.push({ pct, without, with: health });
  }
  return result;
}

/** A plan sized to this account: one full refill from the trigger per rescue, two in reserve. */
export function suggestPlan(risk: AccountRisk, lines: { trigger: number; target: number }, flatFeeUsd: number): StormPlan {
  const refill = Math.max(25, (lines.target - lines.trigger) * risk.maintenance * 1.05 + flatFeeUsd);
  const size = 10 ** Math.floor(Math.log10(refill)) / 2;
  const perRescueUsd = Math.ceil(refill / size) * size;
  return { ...lines, perRescueUsd, perDayUsd: perRescueUsd * 2, reserveUsd: perRescueUsd * 2, flatFeeUsd };
}

/** The direction that hurts: whichever way a 1% move leaves less health. */
export const worseDirection = (risk: AccountRisk, coin: string | null = null): -1 | 1 =>
  healthAfter(risk, -1, coin) <= healthAfter(risk, 1, coin) ? -1 : 1;
