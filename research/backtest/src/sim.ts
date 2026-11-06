import type { Bar } from "./data";

export type Side = 1 | -1; // 1 long, -1 short

export type SimPosition = {
  side: Side;
  leverage: number;
  entryIndex: number; // enters at this bar's open
  marginUsd: number;
  maintenanceRate: number;
  holdMs: number;
};

export type SimPolicy = {
  trigger: number;
  target: number;
  maxPerRescueUsd: number;
  maxPerDayUsd: number;
  cooldownMs: number;
  reserveUsd: number;
  feeUsd: number; // 1Click's flat withdrawFee
  spreadRate: number; // what 1Click keeps on top of the fee
  minSendUsd: number; // below this, 1Click rejects the quote
  latencyMs: number; // trigger detected to money on Hyperliquid
  pollMs: number; // the keeper looks this often
};

export type Outcome = {
  liquidated: boolean;
  liquidatedAt: number | null;
  rescuesFired: number;
  rescuesLate: number; // liquidated while the rescue was still on its way
  reserveUsedUsd: number;
  reserveExhausted: boolean;
  pnlUsd: number; // change in margin plus reserve, so runs with and without Lifeline compare fairly
};

export type PathPoint = { t: number; price: number };

const DAY_MS = 24 * 3_600_000;
const NO_POLICY_POLL_MS = 5_000;
const BUFFER = 1.01;

/**
 * A guess at the path inside a candle, which the data can't show. The adverse
 * extreme comes first, which is the harshest order. By default the price moves at
 * an even pace; `adverseLegMs` squeezes the adverse move into a flash crash.
 */
export function barPath(bar: Bar, barMs: number, side: Side, adverseLegMs?: number): PathPoint[] {
  const adverse = side > 0 ? bar.l : bar.h;
  const favourable = side > 0 ? bar.h : bar.l;
  const prices = [bar.o, adverse, favourable, bar.c];
  const legs = [Math.abs(bar.o - adverse), Math.abs(adverse - favourable), Math.abs(favourable - bar.c)];
  const total = legs[0]! + legs[1]! + legs[2]!;
  if (total === 0) {
    return [
      { t: bar.t, price: bar.o },
      { t: bar.t + barMs, price: bar.o },
    ];
  }

  let durations: number[];
  if (adverseLegMs === undefined) {
    durations = legs.map((leg) => (leg / total) * barMs);
  } else {
    const first = Math.min(adverseLegMs, barMs);
    const rest = legs[1]! + legs[2]!;
    const shareOf = (leg: number) => (rest === 0 ? 0.5 : leg / rest);
    durations = [first, shareOf(legs[1]!) * (barMs - first), shareOf(legs[2]!) * (barMs - first)];
  }

  let t = bar.t;
  return prices.map((price, i) => {
    if (i > 0) t += durations[i - 1]!;
    return { t: Math.round(t), price };
  });
}

/**
 * What the keeper would send, in USD: (needed + fee) × 1.01, cut to the limits, or
 * null if a limit is too small to quote, which the policy engine would block. A test
 * holds this equal to the keeper's real sizeRescue, so the backtest measures Lifeline.
 */
export function rescueSendUsd(neededUsd: number, dayLeftUsd: number, reserveUsd: number, p: SimPolicy): number | null {
  let send = Math.max((Math.max(neededUsd, 0) + p.feeUsd) * BUFFER, p.minSendUsd);
  for (const limit of [p.maxPerRescueUsd, dayLeftUsd, reserveUsd]) {
    if (limit >= p.minSendUsd && send > limit) send = limit;
  }
  return send > p.maxPerRescueUsd || send > dayLeftUsd || send > reserveUsd ? null : send;
}

export function priceAt(points: PathPoint[], t: number): number {
  const first = points[0]!;
  if (t <= first.t) return first.price;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (t <= b.t) return b.t === a.t ? b.price : a.price + ((b.price - a.price) * (t - a.t)) / (b.t - a.t);
  }
  return points.at(-1)!.price;
}

/**
 * Walks one position through real candles. With a policy, it behaves as the keeper
 * does: it looks every poll, fires once below the trigger, sizes the rescue the same
 * way, and the money only counts once the latency has passed. Pure and deterministic.
 */
export function simulate(
  position: SimPosition,
  bars: Bar[],
  barMs: number,
  policy: SimPolicy | null,
  adverseLegMs?: number,
): Outcome {
  const { side, leverage, entryIndex, marginUsd, maintenanceRate, holdMs } = position;
  const entryBar = bars[entryIndex]!;
  const entryPrice = entryBar.o;
  const endT = entryBar.t + holdMs;
  const size = (marginUsd * leverage) / entryPrice;
  const pollMs = policy?.pollMs ?? NO_POLICY_POLL_MS;

  let margin = marginUsd;
  let reserve = policy?.reserveUsd ?? 0;
  let inFlight: { arriveAt: number; deliveredUsd: number } | null = null;
  let nextAllowed = entryBar.t;
  let lastPrice = entryPrice;
  let rescuesFired = 0;
  let reserveUsedUsd = 0;
  const sends: { t: number; usd: number }[] = [];

  const equityAt = (price: number) => margin + side * size * (price - entryPrice);
  const maintenanceAt = (price: number) => size * price * maintenanceRate;
  const healthAt = (price: number) => equityAt(price) / maintenanceAt(price);

  const finish = (liquidatedAt: number | null, price: number): Outcome => {
    const equity = liquidatedAt === null ? equityAt(price) : Math.max(equityAt(price), 0);
    const onItsWay = inFlight?.deliveredUsd ?? 0; // money still lands in the account, even after a liquidation
    return {
      liquidated: liquidatedAt !== null,
      liquidatedAt,
      rescuesFired,
      rescuesLate: liquidatedAt !== null && inFlight !== null ? 1 : 0,
      reserveUsedUsd,
      reserveExhausted: policy !== null && reserve < policy.minSendUsd,
      pnlUsd: equity + onItsWay + reserve - marginUsd - (policy?.reserveUsd ?? 0),
    };
  };

  const fire = (t: number, price: number, p: SimPolicy) => {
    const needed = p.target * maintenanceAt(price) - equityAt(price);
    const dayLeft = p.maxPerDayUsd - sends.filter((s) => t - s.t < DAY_MS).reduce((sum, s) => sum + s.usd, 0);
    const send = rescueSendUsd(needed, dayLeft, reserve, p);
    if (send === null) return;

    reserve -= send;
    reserveUsedUsd += send;
    rescuesFired += 1;
    sends.push({ t, usd: send });
    nextAllowed = t + p.cooldownMs;
    inFlight = { arriveAt: t + p.latencyMs, deliveredUsd: send * (1 - p.spreadRate) - p.feeUsd };
  };

  for (let i = entryIndex; i < bars.length; i += 1) {
    const bar = bars[i]!;
    if (bar.t >= endT) break;
    lastPrice = bar.c;

    // Nothing can happen in this bar, so don't walk it. This is what makes 100,000s of runs quick.
    const threshold = policy !== null && reserve >= policy.minSendUsd ? policy.trigger : 1;
    if (inFlight === null && healthAt(side > 0 ? bar.l : bar.h) >= threshold) continue;

    const path = barPath(bar, barMs, side, adverseLegMs);
    const stop = Math.min(bar.t + barMs, endT);
    for (let t = bar.t; t < stop; t += pollMs) {
      const price = priceAt(path, t);
      if (inFlight !== null && t >= (inFlight as { arriveAt: number }).arriveAt) {
        margin += (inFlight as { deliveredUsd: number }).deliveredUsd;
        inFlight = null;
      }
      const health = healthAt(price);
      if (health <= 1) return finish(t, price);
      if (policy !== null && inFlight === null && health < policy.trigger && t >= nextAllowed) fire(t, price, policy);
    }
    lastPrice = priceAt(path, stop);
  }
  return finish(null, lastPrice);
}
