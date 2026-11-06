import { ASSETS, type AuditRecord } from "@lifeline/shared";
import type { Quote } from "@lifeline/keeper";

const usdcIn = (units: string) => Number(units) / 10 ** ASSETS.NEAR_USDC.decimals;
const usdcOut = (units: string) => Number(units) / 10 ** ASSETS.HYPERLIQUID_USDC.decimals;

export function describeQuote(quote: Quote): string {
  return [
    `${usdcIn(quote.amountIn).toFixed(2)} USDC in`,
    `${usdcOut(quote.minAmountOut).toFixed(2)} USDC guaranteed on Hyperliquid`,
    `${usdcOut(quote.withdrawFee).toFixed(4)} USDC fee`,
    `signature checked`,
    `id ${quote.quoteId}`,
  ].join(", ");
}

export const describeAudit = (record: AuditRecord) => JSON.stringify(record, null, 2);
