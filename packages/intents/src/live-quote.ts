import { ASSETS } from "@lifeline/shared";
import { createOneClick } from "./oneclick";
import { getTokens } from "./tokens";

/**
 * One real dry quote, NEAR USDC to Hyperliquid USDC: no wallet, no funds, nothing sent.
 *   pnpm --filter intents live-quote [usdc] [hyperliquid address] [refund account]
 */
async function main() {
  const [usdc = "5", recipient = "0x1111111111111111111111111111111111111111", refundTo = "demo.near"] = process.argv.slice(2);
  if (!/^\d+(\.\d{1,6})?$/.test(usdc)) throw new Error("the amount is in USDC, like 5 or 2.5");
  const apiUrl = process.env.ONECLICK_API_URL?.trim() || "https://1click.chaindefuser.com";
  const jwt = process.env.ONECLICK_JWT?.trim() || undefined;
  const [whole = "0", fraction = ""] = usdc.split(".");
  const amount = (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))).toString();

  const tokens = await getTokens({ apiUrl, ...(jwt ? { jwt } : {}) });
  const destination = tokens.find((token) => token.assetId === ASSETS.HYPERLIQUID_USDC.assetId);
  console.log(`1Click lists ${tokens.length} tokens. Hyperliquid perps USDC: ${destination ? "listed" : "NOT LISTED"}.`);

  const oneClick = createOneClick({ apiUrl, nearSenderAccount: refundTo, ...(jwt ? { jwt } : {}) });
  const quote = await oneClick.getQuote({ amount, recipient, refundTo, dry: true });
  const out = (units: string) => (Number(units) / 10 ** ASSETS.HYPERLIQUID_USDC.decimals).toFixed(4);
  console.log(`\nDry quote ${quote.quoteId}, signature checked`);
  console.log(`  in:       ${usdc} USDC on NEAR`);
  console.log(`  at least: ${out(quote.minAmountOut)} USDC in ${recipient}'s Hyperliquid perps balance`);
  console.log(`  fee:      ${out(quote.withdrawFee)} USDC`);
  console.log(`  refund:   ${quote.refundTo}`);
  console.log(`  quoted:   ${quote.quotedAt}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
