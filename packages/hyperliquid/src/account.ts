import { isRecord, toNumber } from "./parse";

// A whole account's risk, for people to read. The keeper doesn't use this: it reads
// health.ts, which is deliberately the cautious figure.

export type AccountMode = "standard" | "unified" | "portfolio";

export type RiskPosition = {
  coin: string;
  /** Which perps dex it's on; "" is Hyperliquid's own. */
  dex: string;
  size: number;
  markPx: number;
  entryPx: number;
  liquidationPx: number | null;
  isolated: boolean;
  /** This position's part of maintenance margin, as a share of its value. */
  maintenanceRate: number;
};

export type AccountRisk = {
  mode: AccountMode;
  /** What stands behind the cross positions a top-up can help, in USD. */
  value: number;
  maintenance: number;
  health: number;
  /** The positions behind that health. */
  covered: RiskPosition[];
  /** Positions a top-up can't reach: isolated, or on a dex with its own balance. */
  uncovered: RiskPosition[];
  /** Health the way the keeper reads it, when that differs: it only sees Hyperliquid's own dex. */
  keeperHealth: number | null;
  /** Portfolio margin's own ratio; liquidation at 0.95. Health means nothing there. */
  portfolioRatio: number | null;
  /** Dexes that couldn't be read. Their positions are missing here. */
  unread: string[];
};

export type InfoReader = (body: Record<string, unknown>) => Promise<unknown>;

const LIQUIDATES_AT_RATIO = 0.95;
export { LIQUIDATES_AT_RATIO as PORTFOLIO_LIQUIDATION_RATIO };

type DexState = { value: number; maintenance: number; isolatedMargin: number; positions: RiskPosition[] };

/** One dex's positions and cross figures, or null when any part can't be read. */
export function parseDexState(dex: string, raw: unknown): DexState | null {
  if (!isRecord(raw) || !isRecord(raw.crossMarginSummary) || !Array.isArray(raw.assetPositions)) return null;
  const value = toNumber(raw.crossMarginSummary.accountValue);
  const maintenance = toNumber(raw.crossMaintenanceMarginUsed);
  if (value === null || maintenance === null || maintenance < 0) return null;
  const positions: RiskPosition[] = [];
  let isolatedMargin = 0;
  for (const entry of raw.assetPositions) {
    const p = isRecord(entry) && isRecord(entry.position) ? entry.position : null;
    if (p === null || typeof p.coin !== "string" || !isRecord(p.leverage)) return null;
    const size = toNumber(p.szi);
    const notional = toNumber(p.positionValue);
    const entryPx = toNumber(p.entryPx);
    const maxLeverage = toNumber(p.maxLeverage);
    const liquidationPx = p.liquidationPx === null ? null : toNumber(p.liquidationPx);
    if (size === null || size === 0 || notional === null || !(notional > 0) || entryPx === null || !maxLeverage || (p.liquidationPx !== null && liquidationPx === null)) return null;
    const isolated = p.leverage.type === "isolated";
    if (isolated) {
      const margin = toNumber(p.marginUsed);
      if (margin === null) return null;
      isolatedMargin += margin;
    }
    positions.push({ coin: p.coin, dex, size, markPx: Math.abs(notional / size), entryPx, liquidationPx, isolated, maintenanceRate: 1 / (2 * maxLeverage) });
  }
  // A big position pays a higher tier's rate: scale so the parts add up to what Hyperliquid reports.
  const cross = positions.filter((p) => !p.isolated);
  if ((cross.length > 0) !== maintenance > 0) return null;
  const parts = cross.reduce((sum, p) => sum + Math.abs(p.size) * p.markPx * p.maintenanceRate, 0);
  for (const p of cross) p.maintenanceRate *= maintenance / parts;
  return { value, maintenance, isolatedMargin, positions };
}

const ratio = (value: number, maintenance: number) => (maintenance === 0 ? Number.POSITIVE_INFINITY : value / maintenance);

const modeOf = (raw: unknown): AccountMode | null =>
  raw === "unifiedAccount" ? "unified" : raw === "portfolioMargin" ? "portfolio" : raw === "disabled" || raw === "default" ? "standard" : null;

/**
 * Reads an account in whichever mode it's in. In unified mode one USDC balance stands
 * behind every dex: that balance, less what's locked in isolated positions, over cross
 * maintenance on all of them. It's only used when Hyperliquid's own figure for what's
 * left after maintenance agrees (checked on real accounts on 2026-11-24). Throws when the
 * account can't be read, so a failure is never shown as safe.
 */
export async function readAccountRisk(address: string, read: InfoReader): Promise<AccountRisk> {
  const [rawMode, rawDexes, rawMain] = await Promise.all([
    read({ type: "userAbstraction", user: address }),
    read({ type: "perpDexs" }),
    read({ type: "clearinghouseState", user: address }),
  ]);
  const mode = modeOf(rawMode);
  if (mode === null) throw new Error("This account's margin mode isn't one Lifeline knows.");
  const main = parseDexState("", rawMain);
  if (main === null) throw new Error("Hyperliquid's answer couldn't be read.");

  // The first entry is Hyperliquid's own dex, as null. Anything else unnamed would be a dex left unread.
  if (!Array.isArray(rawDexes) || rawDexes.some((d) => d !== null && !(isRecord(d) && typeof d.name === "string"))) throw new Error("Hyperliquid's list of markets couldn't be read.");
  const names = rawDexes.flatMap((d) => (d === null ? [] : [(d as { name: string }).name]));
  const unread: string[] = [];
  const others = (
    await Promise.all(
      names.map(async (dex) => {
        const state = await read({ type: "clearinghouseState", user: address, dex }).then(
          (raw) => parseDexState(dex, raw),
          () => null,
        );
        if (state === null) unread.push(dex);
        return state;
      }),
    )
  ).filter((s) => s !== null);

  const all = [main, ...others];
  const positions = all.flatMap((s) => s.positions);
  const mainHealth = ratio(main.value, main.maintenance);

  if (mode === "standard") {
    const covered = main.positions.filter((p) => !p.isolated);
    return { mode, value: main.value, maintenance: main.maintenance, health: mainHealth, covered, uncovered: positions.filter((p) => !covered.includes(p)), keeperHealth: null, portfolioRatio: null, unread };
  }

  const spot = await read({ type: "spotClearinghouseState", user: address });
  if (!isRecord(spot)) throw new Error("Hyperliquid's answer couldn't be read.");

  if (mode === "portfolio") {
    const portfolioRatio = toNumber(spot.portfolioMarginRatio);
    if (portfolioRatio === null) throw new Error("Hyperliquid's portfolio margin ratio couldn't be read.");
    return { mode, value: 0, maintenance: 0, health: Number.NaN, covered: [], uncovered: positions, keeperHealth: mainHealth, portfolioRatio, unread };
  }

  if (unread.length > 0) throw new Error(`Couldn't read this unified account's ${unread.join(", ")} positions, so its health isn't known.`);
  const usdcRow = Array.isArray(spot.balances) ? spot.balances.find((b) => isRecord(b) && b.token === 0) : undefined;
  const usdc = usdcRow === undefined ? 0 : isRecord(usdcRow) ? toNumber(usdcRow.total) : null;
  const maintenance = all.reduce((sum, s) => sum + s.maintenance, 0);
  const isolatedMargin = all.reduce((sum, s) => sum + s.isolatedMargin, 0);
  if (usdc === null) throw new Error("Hyperliquid's answer couldn't be read.");
  const leftRow = Array.isArray(spot.tokenToAvailableAfterMaintenance) ? spot.tokenToAvailableAfterMaintenance.find((r) => Array.isArray(r) && r[0] === 0) : undefined;
  const left = Array.isArray(leftRow) ? toNumber(leftRow[1]) : leftRow === undefined && positions.length === 0 ? usdc : null;
  const said = left === null ? Number.NaN : usdc - left;
  // The two reads are moments apart, so prices may have moved a little between them.
  if (!(Math.abs(said - (maintenance + isolatedMargin)) <= Math.max(1, 0.02 * (maintenance + isolatedMargin)))) {
    throw new Error("This unified account's figures don't add up, so its health isn't known.");
  }
  const value = usdc - isolatedMargin;
  const covered = positions.filter((p) => !p.isolated);
  return { mode, value, maintenance, health: ratio(value, maintenance), covered, uncovered: positions.filter((p) => p.isolated), keeperHealth: mainHealth, portfolioRatio: null, unread };
}

export type StopCheck = { coin: string; hasStop: boolean };
export type AgentKey = { name: string; address: string; validUntil: number | null };

/**
 * Which positions have reduce-only stops for their whole size, on the losing side and
 * before liquidation, from `frontendOpenOrders`.
 */
export function stopsFor(positions: RiskPosition[], orders: unknown): StopCheck[] | null {
  if (!Array.isArray(orders)) return null;
  return positions.map((p) => {
    const long = p.size > 0;
    let covered = 0;
    for (const o of orders) {
      if (!isRecord(o) || o.coin !== p.coin || o.isTrigger !== true || o.reduceOnly !== true) continue;
      const at = toNumber(o.triggerPx);
      // A long sells ("A") below the price; a short buys ("B") above it.
      if (at === null || o.side !== (long ? "A" : "B") || !(long ? at < p.markPx : at > p.markPx)) continue;
      if (p.liquidationPx !== null && !(long ? at > p.liquidationPx : at < p.liquidationPx)) continue;
      covered += o.isPositionTpsl === true ? Math.abs(p.size) : (toNumber(o.sz) ?? 0);
    }
    return { coin: p.coin, hasStop: covered >= Math.abs(p.size) * 0.99 };
  });
}

/** Keys allowed to trade for this account, from `extraAgents`. */
export function parseAgents(raw: unknown): AgentKey[] | null {
  if (!Array.isArray(raw)) return null;
  const agents = raw.map((a) =>
    isRecord(a) && typeof a.address === "string" ? { name: typeof a.name === "string" ? a.name : "", address: a.address, validUntil: toNumber(a.validUntil) } : null,
  );
  return agents.includes(null) ? null : (agents as AgentKey[]);
}
