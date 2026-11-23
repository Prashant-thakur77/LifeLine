import type { Aftermath, Liquidation } from "@lifeline/hyperliquid";
import { formatPrice, formatUsd } from "./format";

export const WINDOW_LABEL: Record<number, string> = { 24: "1 day", 72: "3 days", 168: "7 days" };
export const signedUsd = (usd: number) => `${usd < 0 ? "−" : "+"}${formatUsd(Math.abs(usd))}`;
export const dayOf = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** One sentence that is as plain about the bad outcome as the good one. */
export function sentence(l: Liquidation, a: Aftermath): string {
  const held = `At least about ${formatUsd(a.neededUsd)} more margin would have held this ${l.side} for ${WINDOW_LABEL[a.hours]}.`;
  return a.againstLiquidationUsd > 0
    ? `${held} By then it was worth ${formatUsd(a.againstLiquidationUsd)} more than when it was liquidated.`
    : `${held} But by then it was worth ${formatUsd(-a.againstLiquidationUsd)} less, so being liquidated cost less than holding on.`;
}

export type Tally = { recovered: number; total: number };
export function tally(all: (Aftermath[] | undefined)[], hours: number): Tally {
  const windows = all.flatMap((list) => list?.filter((a) => a.hours === hours) ?? []);
  return { recovered: windows.filter((a) => a.againstLiquidationUsd > 0).length, total: windows.length };
}

export const liquidationLine = (l: Liquidation) => `${l.side === "long" ? "Long" : "Short"} ${l.coin}, liquidated at ${formatPrice(l.price)}`;
