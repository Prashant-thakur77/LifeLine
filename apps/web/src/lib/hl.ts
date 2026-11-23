import { aftermath, findLiquidations, intervalFor, parseAgents, parseClearinghouseState, readAccountRisk, stopsFor, type AccountRisk, type Aftermath, type AgentKey, type Candle, type HealthResult, type Liquidation, type StopCheck, WINDOWS_H } from "@lifeline/hyperliquid";

/** Hyperliquid's public info API. It answers browsers directly, with no key. */
export const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

async function info(body: unknown, fetchFn: typeof fetch): Promise<unknown> {
  const response = await fetchFn(HL_INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid answered ${response.status}`);
  return response.json();
}

/**
 * Any Hyperliquid account's health, read live: the same parser the keeper uses, so a
 * failed or ambiguous read comes back "unknown", never safe.
 */
export async function checkAddress(address: string, fetchFn: typeof fetch = fetch): Promise<HealthResult> {
  const trimmed = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return { status: "unknown", reason: "INVALID_ADDRESS" };
  try {
    return parseClearinghouseState(trimmed, await info({ type: "clearinghouseState", user: trimmed }, fetchFn));
  } catch (error) {
    return { status: "unknown", reason: "API_ERROR", detail: error instanceof Error ? error.message : String(error) };
  }
}

export type AccountCheck = { risk: AccountRisk; stops: StopCheck[] | null; agents: AgentKey[] | null };

/** Everything the storm test needs about an account. Throws when its risk can't be read. */
export async function checkAccount(address: string, fetchFn: typeof fetch = fetch): Promise<AccountCheck> {
  const user = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(user)) throw new Error("That doesn't look like a Hyperliquid address.");
  const read = (body: Record<string, unknown>) => info(body, fetchFn);
  const or = (work: Promise<unknown>) => work.catch(() => null);
  const [risk, agents] = await Promise.all([readAccountRisk(user, read), or(read({ type: "extraAgents", user }))]);
  // Orders are kept per dex, so each dex with a position is asked.
  const positions = [...risk.covered, ...risk.uncovered];
  const dexes = [...new Set(positions.map((p) => p.dex))];
  const orders = await Promise.all(dexes.map((dex) => or(read({ type: "frontendOpenOrders", user, ...(dex ? { dex } : {}) }))));
  const stops = orders.every(Array.isArray) ? stopsFor(positions, orders.flat()) : null;
  return { risk, stops, agents: parseAgents(agents) };
}

/** An account's own liquidations among its latest 2,000 fills. Throws when they can't be read. */
export async function readLiquidations(address: string, fetchFn: typeof fetch = fetch): Promise<Liquidation[]> {
  const user = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(user)) throw new Error("That doesn't look like a Hyperliquid address.");
  const found = findLiquidations(user, await info({ type: "userFills", user }, fetchFn));
  if (found === null) throw new Error("Hyperliquid's answer couldn't be read.");
  return found;
}

/** What the price did after one liquidation, for each window that's over. */
export async function readAftermath(l: Liquidation, now: number, fetchFn: typeof fetch = fetch): Promise<Aftermath[]> {
  const { interval, ms } = intervalFor(l.endedAt, now);
  const last = Math.max(...WINDOWS_H) * 3_600_000;
  const raw = await info({ type: "candleSnapshot", req: { coin: l.coin, interval, startTime: l.endedAt - ms, endTime: Math.min(l.endedAt + last, now) } }, fetchFn);
  if (!Array.isArray(raw)) throw new Error("Hyperliquid's prices couldn't be read.");
  const candles: Candle[] = raw.map((c: Record<string, unknown>) => ({ openTime: Number(c.t), closeTime: Number(c.T), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v), trades: Number(c.n) }));
  if (candles.some((c) => ![c.openTime, c.closeTime, c.high, c.low, c.close].every((n) => Number.isFinite(n) && n > 0))) throw new Error("Hyperliquid's prices couldn't be read.");
  return WINDOWS_H.flatMap((hours) => aftermath(l, candles, ms, hours, now) ?? []);
}

/** A coin's live mid price, or null when Hyperliquid can't be read. */
export async function midPrice(coin: string, fetchFn: typeof fetch = fetch): Promise<number | null> {
  try {
    const mids = (await info({ type: "allMids" }, fetchFn)) as Record<string, string>;
    const value = Number(mids[coin]);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
