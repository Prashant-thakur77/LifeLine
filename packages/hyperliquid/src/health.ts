import type { HealthSnapshot } from "@lifeline/shared";
import { postInfo, type InfoOptions } from "./info";
import { isRecord, toNumber } from "./parse";

export type UnknownReason =
  | "INVALID_ADDRESS"
  | "API_ERROR"
  | "MALFORMED_RESPONSE"
  | "ISOLATED_ONLY"
  | "INCONSISTENT_MARGIN";

/**
 * What we know about an account. "unknown" has no snapshot on purpose, so a
 * failed read can't be mistaken for a safe account.
 */
export type HealthResult =
  | {
      status: "ok";
      snapshot: HealthSnapshot;
      /** Isolated positions in this account. A top-up can't protect them. */
      isolatedCoins: string[];
    }
  | { status: "unknown"; reason: UnknownReason; detail?: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const unknown = (reason: UnknownReason, detail?: string): HealthResult =>
  detail === undefined ? { status: "unknown", reason } : { status: "unknown", reason, detail };

type ParsedPosition = HealthSnapshot["positions"][number] & { isolated: boolean };

function parsePosition(entry: unknown): ParsedPosition | null {
  if (!isRecord(entry) || !isRecord(entry.position)) return null;
  const { coin, szi, entryPx, liquidationPx, leverage } = entry.position;
  if (typeof coin !== "string" || !isRecord(leverage)) return null;
  if (leverage.type !== "cross" && leverage.type !== "isolated") return null;

  const size = toNumber(szi);
  const entryPrice = toNumber(entryPx);
  const liquidation = liquidationPx === null ? null : toNumber(liquidationPx);
  if (size === null || entryPrice === null) return null;
  if (liquidation === null && liquidationPx !== null) return null;

  return {
    coin,
    size,
    entryPx: entryPrice,
    liquidationPx: liquidation,
    isolated: leverage.type === "isolated",
  };
}

/**
 * Turns a clearinghouseState response into a health reading.
 *
 * Health covers cross margin only, because that's the balance a top-up adds to.
 * Both sides of the ratio must be cross figures: marginSummary.accountValue also
 * counts isolated margin, which can't save a cross position, so using it would
 * overstate health.
 */
export function parseClearinghouseState(hlAddress: string, raw: unknown): HealthResult {
  if (!isRecord(raw) || !isRecord(raw.crossMarginSummary) || !Array.isArray(raw.assetPositions)) {
    return unknown("MALFORMED_RESPONSE");
  }

  const accountValue = toNumber(raw.crossMarginSummary.accountValue);
  const maintenanceMarginUsed = toNumber(raw.crossMaintenanceMarginUsed);
  const time = toNumber(raw.time);
  if (accountValue === null || maintenanceMarginUsed === null || maintenanceMarginUsed < 0) {
    return unknown("MALFORMED_RESPONSE");
  }
  if (time === null || Number.isNaN(new Date(time).getTime())) {
    return unknown("MALFORMED_RESPONSE");
  }

  const parsed = raw.assetPositions.map(parsePosition);
  if (parsed.some((position) => position === null)) return unknown("MALFORMED_RESPONSE");
  const all = parsed as ParsedPosition[];
  const isolatedCoins = all.filter((p) => p.isolated).map((p) => p.coin);
  const hasCrossPositions = all.some((p) => !p.isolated);

  // Zero margin only means "safe" when the account truly holds nothing.
  if (maintenanceMarginUsed === 0) {
    if (hasCrossPositions) return unknown("INCONSISTENT_MARGIN");
    if (isolatedCoins.length > 0) return unknown("ISOLATED_ONLY");
  }

  return {
    status: "ok",
    isolatedCoins,
    snapshot: {
      hlAddress,
      accountValue,
      maintenanceMarginUsed,
      health:
        maintenanceMarginUsed === 0
          ? Number.POSITIVE_INFINITY
          : accountValue / maintenanceMarginUsed,
      positions: all.map(({ isolated: _isolated, ...position }) => position),
      at: new Date(time).toISOString(),
    },
  };
}

/** Reads an account's health. Never throws, and never reports a failure as safe. */
export async function getHealth(
  hlAddress: string,
  options: InfoOptions = {},
): Promise<HealthResult> {
  if (!ADDRESS.test(hlAddress)) return unknown("INVALID_ADDRESS");
  try {
    const raw = await postInfo({ type: "clearinghouseState", user: hlAddress }, options);
    return parseClearinghouseState(hlAddress, raw);
  } catch (error) {
    return unknown("API_ERROR", error instanceof Error ? error.message : String(error));
  }
}
