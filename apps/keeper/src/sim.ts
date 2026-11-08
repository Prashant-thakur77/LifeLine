import { ASSETS, POLICY_DEFAULTS, type AuditRecord, type Policy } from "@lifeline/shared";
import { Keeper } from "./keeper";
import type { Intents, ReadHealth, RescueArgs, RescueRecord, SwapStatus, Vault } from "./ports";
import type { Store } from "./store";

/** A real mainnet account: 1Click refuses a quote whose refundTo doesn't exist. */
export const SIM_USER = "demo.near";
const SIM_HL_ADDRESS = "0x1111111111111111111111111111111111111111";

const NOTIONAL_USD = 300;
const BASE_PRICE = 3000; // what PRICE_DROP is written against
const START_MARGIN_USD = 30; // 10× on 300 USD of ETH
const MAINTENANCE_RATE = 0.02; // half the initial margin at ETH's 25× max leverage
const START_RESERVE = "100000000"; // 100 USDC
const LAST_SEEN_FEE_USD = 0.3153; // replaced as soon as a quote reports the fee

/** ETH price at each tick from a 3,000 start: through warn at 2800 and the trigger at 2780, then flat. */
export const PRICE_DROP = [3000, 2960, 2920, 2880, 2840, 2800, 2780, 2780, 2780, 2780, 2780, 2780];

const SETTLEMENT: SwapStatus[] = ["KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"];

export type SimWorld = {
  hlAddress: string;
  setPrice(price: number): void;
  readHealth: ReadHealth;
  vault: Vault;
  intents: Intents;
  sent: RescueArgs[];
  reserve(): string;
};

/**
 * A pretend account, vault and settlement, so the real keeper can run with no
 * wallet, keys or funds. Only the quotes are real, and they're always dry.
 */
export function createSimWorld(options: { quotes: Pick<Intents, "getQuote">; now: () => Date; entryPrice?: number }): SimWorld {
  const { quotes, now, entryPrice = BASE_PRICE } = options;
  const size = NOTIONAL_USD / entryPrice;
  let price = entryPrice;
  let margin = START_MARGIN_USD;
  let reserve = BigInt(START_RESERVE);
  let feeUsd = LAST_SEEN_FEE_USD;
  const sent: RescueArgs[] = [];
  const rescues: RescueRecord[] = [];
  const deposits = new Map<string, { amount: string; step: number }>();

  const policy: Policy = { user: SIM_USER, hlAddress: SIM_HL_ADDRESS, ...POLICY_DEFAULTS, paused: false };

  return {
    hlAddress: SIM_HL_ADDRESS,
    sent,
    reserve: () => reserve.toString(),
    setPrice(next) {
      price = next;
    },

    readHealth: async () => {
      const accountValue = margin + size * (price - entryPrice);
      const maintenanceMarginUsed = size * price * MAINTENANCE_RATE;
      const liquidationPx = (size * entryPrice - margin) / (size * (1 - MAINTENANCE_RATE));
      return {
        status: "ok",
        isolatedCoins: [],
        snapshot: {
          hlAddress: SIM_HL_ADDRESS,
          accountValue,
          maintenanceMarginUsed,
          health: accountValue / maintenanceMarginUsed,
          positions: [{ coin: "ETH", size, entryPx: entryPrice, liquidationPx }],
          at: now().toISOString(),
        },
      };
    },

    vault: {
      getPolicy: async (user) => (user === SIM_USER ? policy : null),
      getReserve: async () => reserve.toString(),
      getRescues: async () => rescues,
      async rescue(args) {
        reserve -= BigInt(args.amount);
        sent.push(args);
        rescues.push({ amount: args.amount, at: now().toISOString(), quoteId: args.quoteId });
        deposits.set(args.depositAddress, { amount: args.amount, step: 0 });
        return { txHash: `sim-tx-${sent.length}` };
      },
    },

    intents: {
      async getQuote(params) {
        const quote = await quotes.getQuote({ ...params, dry: true });
        feeUsd = Number(quote.withdrawFee) / 10 ** ASSETS.HYPERLIQUID_USDC.decimals;
        return quote;
      },
      async getStatus(depositAddress) {
        const deposit = deposits.get(depositAddress);
        if (deposit === undefined) return "PENDING_DEPOSIT";
        const status = SETTLEMENT[deposit.step] ?? "SUCCESS";
        if (deposit.step === SETTLEMENT.length - 1) {
          margin += Number(deposit.amount) / 10 ** ASSETS.NEAR_USDC.decimals - feeUsd;
        }
        deposit.step += 1;
        return status;
      },
      submitDeposit: async () => {},
    },
  };
}

export type SimResult = { sent: RescueArgs[]; reserveBefore: string; reserveAfter: string };

/** Runs the real keeper through the scripted price drop. */
export async function runSim(options: {
  store: Store;
  quotes: Pick<Intents, "getQuote">;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  tickMs?: number;
  startPrice?: number; // scales the whole script, so a demo can open at the live price
  onRecord?: (record: AuditRecord) => void;
  onTick?: (price: number, health: number) => void;
}): Promise<SimResult> {
  const { store, quotes, now, sleep, log, tickMs = 1000, startPrice = BASE_PRICE, onRecord, onTick } = options;
  const world = createSimWorld({ quotes, now, entryPrice: startPrice });
  const scale = startPrice / BASE_PRICE;
  const keeper = new Keeper({
    store,
    vault: world.vault,
    intents: world.intents,
    readHealth: world.readHealth,
    users: () => [SIM_USER],
    now,
    sleep,
    newId: () => crypto.randomUUID(),
    dryQuotes: true,
    log,
    ...(onRecord ? { onRecord } : {}),
  });

  const reserveBefore = world.reserve();
  for (const scriptPrice of PRICE_DROP) {
    const price = scriptPrice * scale;
    world.setPrice(price);
    await keeper.tick();
    const read = await world.readHealth(world.hlAddress);
    if (read.status === "ok") onTick?.(price, read.snapshot.health);
    await sleep(tickMs);
  }
  await keeper.settled();
  return { sent: world.sent, reserveBefore, reserveAfter: world.reserve() };
}

const SHOW_RESCUED_MS = 60_000; // after a rescue, keep reading for a minute so the API shows the new health

export type SimLoop = {
  /** One alarm's worth: moves the script on a step, or holds, then runs one keeper tick. */
  tick(): Promise<void>;
  /**
   * When the next tick is needed. Between drops nothing changes, so the host can sleep
   * until the rest is over: an always-awake Durable Object costs duration all day.
   */
  nextTickInMs(tickMs: number): number;
  /** Resolves once the current drop's rescue, if any, has finished. */
  settled(): Promise<void>;
};

type Cycle = { world: SimWorld; keeper: Keeper; scale: number; step: number; doneAt: number | null };

/**
 * The scripted drop on repeat, for a hosted demo. Each tick moves the price one step;
 * at the end the price holds while the keeper keeps watching, so the API shows the
 * health after the rescue. After a rest, a new drop starts from the live price. Each
 * drop gets a fresh pretend account and vault, so one drop's rescue can't count
 * against the next one's caps or cooldown. Like runSim, only the quotes are real,
 * and they're always dry.
 */
export function createSimLoop(options: {
  store: Store;
  quotes: Pick<Intents, "getQuote">;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  restMs: number;
  startPrice?: () => Promise<number>;
  onRecord?: (record: AuditRecord) => void;
}): SimLoop {
  const { store, quotes, now, sleep, log, restMs, startPrice, onRecord } = options;
  let cycle: Cycle | null = null;
  let busy = false;

  const begin = async (): Promise<Cycle> => {
    let entry = BASE_PRICE;
    try {
      const live = await startPrice?.();
      if (live !== undefined && Number.isFinite(live) && live > 0) entry = live;
    } catch (error) {
      log(`sim: live price unavailable, starting at ${BASE_PRICE}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const world = createSimWorld({ quotes, now, entryPrice: entry });
    const keeper = new Keeper({
      store,
      vault: world.vault,
      intents: world.intents,
      readHealth: world.readHealth,
      users: () => [SIM_USER],
      now,
      sleep,
      newId: () => crypto.randomUUID(),
      dryQuotes: true,
      log,
      ...(onRecord ? { onRecord } : {}),
    });
    return { world, keeper, scale: entry / BASE_PRICE, step: 0, doneAt: null };
  };

  return {
    async tick() {
      // The host doesn't wait for a tick, so one can arrive before the last has finished.
      if (busy) return;
      busy = true;
      try {
        const rested = cycle !== null && cycle.doneAt !== null && now().getTime() - cycle.doneAt >= restMs;
        if (cycle === null || rested) cycle = await begin();
        const current = cycle;
        const scripted = PRICE_DROP[current.step];
        if (scripted !== undefined) {
          current.world.setPrice(scripted * current.scale);
          current.step += 1;
          if (current.step === PRICE_DROP.length) {
            // The rest only counts once this drop's rescue has finished.
            void current.keeper.settled().then(() => {
              current.doneAt = now().getTime();
            });
          }
        }
        await current.keeper.tick();
      } finally {
        busy = false;
      }
    },
    nextTickInMs(tickMs) {
      if (cycle === null || cycle.doneAt === null) return tickMs;
      const sinceDone = now().getTime() - cycle.doneAt;
      return sinceDone < SHOW_RESCUED_MS ? tickMs : Math.max(tickMs, restMs - sinceDone);
    },
    settled: () => cycle?.keeper.settled() ?? Promise.resolve(),
  };
}
