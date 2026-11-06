import { KEEPER_POLL_INTERVAL_SEC, POLICY_DEFAULTS } from "@lifeline/shared";
import type { Side, SimPolicy } from "./sim";

export const COINS = ["BTC", "ETH", "SOL"] as const;
export type Coin = (typeof COINS)[number];

/** 1d reaches furthest back, 4h is the finest with years of history, and 1m is the closest to real price speed. */
export const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Interval = (typeof INTERVALS)[number];

const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const INTERVAL_MS: Record<Interval, number> = {
  "1m": HOUR_MS / 60,
  "5m": HOUR_MS / 12,
  "15m": HOUR_MS / 4,
  "1h": HOUR_MS,
  "4h": 4 * HOUR_MS,
  "1d": DAY_MS,
};

/**
 * Half the initial margin at max leverage, per Hyperliquid's liquidation docs. Max
 * leverage from its meta endpoint on 2026-11-06: BTC 40, ETH 25, SOL 20.
 */
export const MAINTENANCE_RATE: Record<Coin, number> = { BTC: 1 / 80, ETH: 1 / 50, SOL: 1 / 40 };

export const LEVERAGES = [5, 10, 20] as const;
export const SIDES: readonly Side[] = [1, -1];
export const POSITIONS_PER_CELL = 1000; // per coin, leverage and side
export const MARGIN_USD = 100;
export const RESERVE_USD = MARGIN_USD / 2; // the plan's 50% of initial margin
export const FLASH_ADVERSE_MS = 60_000; // stress test: each candle's adverse move takes one minute
const SEED = 20261106;

export const seedFor = (coin: Coin, leverage: number, side: Side) =>
  SEED + COINS.indexOf(coin) * 1000 + leverage * 10 + (side > 0 ? 1 : 0);

/** The default policy, and 1Click's fee and minimum as seen live on 2026-11-06. */
export const BASE_POLICY: Omit<SimPolicy, "latencyMs"> = {
  trigger: POLICY_DEFAULTS.trigger,
  target: POLICY_DEFAULTS.target,
  maxPerRescueUsd: Number(POLICY_DEFAULTS.maxPerRescue) / 1e6,
  maxPerDayUsd: Number(POLICY_DEFAULTS.maxPerDay) / 1e6,
  cooldownMs: POLICY_DEFAULTS.cooldownSec * 1000,
  reserveUsd: RESERVE_USD,
  feeUsd: 0.3153,
  spreadRate: 0.00011,
  minSendUsd: 2,
  pollMs: KEEPER_POLL_INTERVAL_SEC * 1000,
};

export type Run = { id: string; label: string; interval: Interval; holdDays: number; flash: boolean };

/** The first two are the headline. The rest show how much the answer depends on our choices. */
export const RUNS: Run[] = [
  { id: "primary", label: "4h candles, 7-day hold", interval: "4h", holdDays: 7, flash: false },
  { id: "primary-flash", label: "4h candles, 7-day hold, flash crash", interval: "4h", holdDays: 7, flash: true },
  { id: "hold-30", label: "4h candles, 30-day hold", interval: "4h", holdDays: 30, flash: false },
  { id: "1h", label: "1h candles, 7-day hold", interval: "1h", holdDays: 7, flash: false },
  { id: "1h-flash", label: "1h candles, 7-day hold, flash crash", interval: "1h", holdDays: 7, flash: true },
  { id: "15m", label: "15m candles, 7-day hold", interval: "15m", holdDays: 7, flash: false },
  { id: "15m-flash", label: "15m candles, 7-day hold, flash crash", interval: "15m", holdDays: 7, flash: true },
  { id: "5m", label: "5m candles, 7-day hold", interval: "5m", holdDays: 7, flash: false },
  { id: "1m", label: "1m candles, 1-day hold", interval: "1m", holdDays: 1, flash: false },
  { id: "1d", label: "1d candles, 7-day hold (longest window)", interval: "1d", holdDays: 7, flash: false },
];
