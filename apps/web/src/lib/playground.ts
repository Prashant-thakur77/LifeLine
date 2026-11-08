/**
 * The landing page's price playground: one long ETH position walked down a price drop,
 * with and without Lifeline, using Lifeline's real rules. It's maths, not a simulation
 * of the keeper: no network, no time, no money. The page says so.
 *
 *   health          = account value ÷ maintenance margin (liquidation at 1.0)
 *   rescue          = (target × maintenance − account value + flat fee) × 1.01,
 *                     cut to the per-rescue cap, what's left of the day's cap and the reserve,
 *                     and never less than 2 USDC
 *   what lands      = the rescue less 1Click's flat fee and its ~0.011 % spread
 *
 * It ignores the 2-minute cooldown, as if the price fell more slowly than that.
 */

/** Half the initial margin at ETH's 25x maximum leverage, as Hyperliquid sets it. */
export const MAINTENANCE_RATE = 0.02;
/** 1Click's flat fee on NEAR USDC → Hyperliquid USDC, as measured on 2026-11-06. */
export const FLAT_FEE_USD = 0.3153;
const SPREAD = 0.00011;
const MIN_RESCUE_USD = 2;
const STEP_PCT = 0.05;
const SEARCH_TO_PCT = 80;

export type PlaygroundInput = {
  startPrice: number;
  notionalUsd: number;
  leverage: number;
  /** How far the price has fallen, in percent of the start price. */
  dropPct: number;
  lifeline: boolean;
  trigger: number;
  target: number;
  reserveUsd: number;
  perRescueUsd: number;
  perDayUsd: number;
};

export type PlaygroundRescue = { atDropPct: number; amountUsd: number; landedUsd: number; healthBefore: number; healthAfter: number };

export type PlaygroundResult = {
  price: number;
  liquidationPrice: number;
  /** The drop that liquidates the position without Lifeline. */
  liquidationDropPct: number;
  healthWithout: number;
  liquidatedWithout: boolean;
  healthWith: number;
  liquidatedWith: boolean;
  /** Rescues sent on the way down to `dropPct`. */
  rescues: PlaygroundRescue[];
  spentUsd: number;
  /** The drop that finally liquidates the position with Lifeline on, within the caps and the reserve. */
  survivesToDropPct: number;
};

/** The price at which account value meets maintenance margin, for a long. */
export function liquidationPrice(o: { startPrice: number; notionalUsd: number; marginUsd: number }): number {
  const size = o.notionalUsd / o.startPrice;
  return (size * o.startPrice - o.marginUsd) / (size * (1 - MAINTENANCE_RATE));
}

export function playground(i: PlaygroundInput): PlaygroundResult {
  const size = i.notionalUsd / i.startPrice;
  const margin = i.notionalUsd / i.leverage;
  const liq = liquidationPrice({ startPrice: i.startPrice, notionalUsd: i.notionalUsd, marginUsd: margin });
  const priceAt = (drop: number) => i.startPrice * (1 - drop / 100);
  const maintenance = (p: number) => size * p * MAINTENANCE_RATE;
  const valueAt = (p: number) => margin + size * (p - i.startPrice);
  const price = priceAt(i.dropPct);

  // Walk down in small steps, rescuing whenever health is below the trigger.
  const walk = (toPct: number) => {
    let topUps = 0;
    let spent = 0;
    const rescues: PlaygroundRescue[] = [];
    for (let drop = 0; drop <= toPct + 1e-9; drop += STEP_PCT) {
      const p = priceAt(drop);
      const value = valueAt(p) + topUps;
      const health = value / maintenance(p);
      if (health <= 1) return { rescues, spent, liquidatedAt: drop, topUps };
      if (i.lifeline && health < i.trigger) {
        const needed = i.target * maintenance(p) - value;
        const want = (needed + FLAT_FEE_USD) * 1.01;
        const send = Math.min(want, i.perRescueUsd, i.perDayUsd - spent, i.reserveUsd - spent);
        if (send >= MIN_RESCUE_USD) {
          const landed = send - FLAT_FEE_USD - send * SPREAD;
          topUps += landed;
          spent += send;
          rescues.push({ atDropPct: Math.round(drop * 100) / 100, amountUsd: send, landedUsd: landed, healthBefore: health, healthAfter: (value + landed) / maintenance(p) });
        }
      }
    }
    return { rescues, spent, liquidatedAt: null as number | null, topUps };
  };

  const toHere = walk(i.dropPct);
  const all = walk(SEARCH_TO_PCT);
  const healthWithout = valueAt(price) / maintenance(price);
  const healthWith = (valueAt(price) + toHere.topUps) / maintenance(price);

  return {
    price,
    liquidationPrice: liq,
    liquidationDropPct: (1 - liq / i.startPrice) * 100,
    healthWithout,
    liquidatedWithout: healthWithout <= 1,
    healthWith: i.lifeline ? healthWith : healthWithout,
    liquidatedWith: i.lifeline ? toHere.liquidatedAt !== null : healthWithout <= 1,
    rescues: i.lifeline ? toHere.rescues : [],
    spentUsd: i.lifeline ? toHere.spent : 0,
    survivesToDropPct: i.lifeline ? (all.liquidatedAt ?? SEARCH_TO_PCT) : (1 - liq / i.startPrice) * 100,
  };
}
