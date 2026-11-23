import { parseAgents, parseClearinghouseState, readAccountRisk, stopsFor, type AccountRisk, type AgentKey, type HealthResult, type StopCheck } from "@lifeline/hyperliquid";

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
