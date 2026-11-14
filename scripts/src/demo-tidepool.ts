/**
 * Lifeline's money path on testnet, end to end, through Tidepool: a signed quote from NEAR
 * testnet USDC to a Hyperliquid testnet perps balance, checked, paid from a real NEAR
 * testnet account, and watched until the USDC shows on Hyperliquid. 1Click has no
 * testnet; Tidepool is a community sandbox with 1Click's API, not NEAR Intents itself.
 *
 *   pnpm demo:tidepool --dry [0xaddress]   steps 1 to 3: read, quote, check. Sends nothing.
 *   pnpm demo:tidepool                     the real run: sends 3 test USDC. Reads .env.
 */
import { existsSync } from "node:fs";
import { getHealth } from "@lifeline/hyperliquid";
import { createOneClick, type Quote, type SwapStatus } from "@lifeline/intents";
import { Account, actions, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";
import {
  AMOUNT,
  HL_TESTNET_API,
  NEAR_TESTNET_RPC,
  TIDEPOOL,
  depositActions,
  formatSummary,
  hlAccountLink,
  nearTxLink,
  quoteProblems,
  readSettings,
  statusLink,
  waitForBalanceChange,
  waitForFinalStatus,
} from "./tidepool";

const STATUS_TIMEOUT_MS = 10 * 60_000;
/** After the swap is final, how long to wait for the USDC to show on Hyperliquid. */
const BALANCE_TIMEOUT_MS = 5 * 60_000;

const env = new URL("../../.env", import.meta.url);
if (existsSync(env)) process.loadEnvFile(env);

/** The Hyperliquid testnet perps balance, read with packages/hyperliquid against the testnet API. */
async function readBalance(address: string): Promise<number> {
  const result = await getHealth(address, { apiUrl: HL_TESTNET_API });
  if (result.status !== "ok") throw new Error(`Hyperliquid testnet: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
  return result.snapshot.accountValue;
}

const usdcUnits = (units: string) => `${Number(units) / 1e6} USDC`;

function printQuote(quote: Quote) {
  console.log(`  quote:      ${quote.quoteId} (${quote.quotedAt})`);
  console.log(`  pays:       ${usdcUnits(quote.amountIn)} from NEAR testnet, at least ${usdcUnits(quote.minAmountOut)} to ${quote.recipient}`);
  console.log(`  asset:      ${quote.destinationAsset}`);
  console.log(`  refunds:    ${quote.refundTo}`);
  console.log(`  deposit to: ${quote.depositAddress ?? "none (dry)"}`);
}

async function main() {
  const settings = readSettings(process.argv.slice(2), process.env);
  const tidepool = createOneClick({
    apiUrl: TIDEPOOL.apiUrl,
    nearSenderAccount: settings.nearAccount,
    quoteSigner: TIDEPOOL.quoteSigner,
    originAsset: TIDEPOOL.originAsset,
    destinationAsset: TIDEPOOL.destinationAsset,
    // Tidepool prices its fee into amountOut and sends no withdrawFee.
    withdrawFeeOptional: true,
  });

  console.log(`Lifeline on testnet through Tidepool${settings.dry ? " (dry run: nothing is sent)" : ""}\n`);

  console.log("1. Hyperliquid testnet balance");
  const before = await readBalance(settings.hlAddress);
  console.log(`  ${settings.hlAddress}: ${before} USDC (${hlAccountLink(settings.hlAddress)})\n`);

  console.log("2. A live quote from Tidepool, 3 USDC to that perps balance");
  // getQuote checks the signature against Tidepool's key, and that every field asked for came back unchanged.
  const quote = await tidepool.getQuote({ amount: AMOUNT, recipient: settings.hlAddress, refundTo: settings.nearAccount, dry: false });
  printQuote(quote);

  console.log("\n3. Checks");
  console.log(`  signature:  valid, Tidepool's maker key ${TIDEPOOL.quoteSigner}`);
  const problems = quoteProblems(quote, { recipient: settings.hlAddress, refundTo: settings.nearAccount, amount: AMOUNT });
  if (problems.length > 0) {
    for (const problem of problems) console.log(`  REFUSED:    ${problem}`);
    console.log("\nStopping: nothing was sent.");
    process.exit(1);
  }
  console.log("  recipient, asset, amount, minimum out, refund account and deposit address: all as asked");

  if (settings.dry) {
    console.log("\nDry run: stopping before the deposit. Nothing was sent, and the quote's deposit address is never paid.");
    return;
  }

  const depositAddress = quote.depositAddress!;
  const provider = new JsonRpcProvider({ url: NEAR_TESTNET_RPC });
  const account = new Account(settings.nearAccount, provider, settings.nearKey as KeyPairString);
  const view = <T>(method: string, args: Record<string, unknown>) => provider.callFunction<T & object>({ contractId: TIDEPOOL.usdcContract, method, args }) as Promise<T>;

  console.log("\n4. The deposit, from NEAR testnet");
  const balance = await view<string>("ft_balance_of", { account_id: settings.nearAccount });
  if (BigInt(balance ?? "0") < BigInt(AMOUNT)) {
    console.log(`  ${settings.nearAccount} holds ${usdcUnits(balance ?? "0")}, less than 3. Claim test USDC at https://app.usetidepool.tech/faucet first.`);
    process.exit(1);
  }
  const registered = await view<unknown>("storage_balance_of", { account_id: depositAddress });
  const bounds = await view<{ min: string }>("storage_balance_bounds", {});
  const steps = depositActions(depositAddress, AMOUNT, registered === null || registered === undefined ? BigInt(bounds.min) : null);
  console.log(`  ${settings.nearAccount} holds ${usdcUnits(balance)}; sending ${usdcUnits(AMOUNT)} to ${depositAddress} (${steps.map((s) => s.method).join(" + ")})`);

  const sent = await account.signAndSendTransaction({
    receiverId: TIDEPOOL.usdcContract,
    actions: steps.map((s) => actions.functionCall(s.method, s.args, teraToGas(s.gasTgas), s.depositYocto)),
    waitUntil: "EXECUTED_OPTIMISTIC",
    throwOnFailure: false,
  });
  const depositAt = Date.now();
  const txHash = sent.transaction.hash;
  const status = sent.status as { Failure?: unknown } | string | undefined;
  if (typeof status === "object" && status?.Failure !== undefined) {
    console.log(`  the deposit failed on chain: ${JSON.stringify(status.Failure)}\n  ${nearTxLink(txHash)}`);
    process.exit(1);
  }
  console.log(`  sent: ${nearTxLink(txHash)}`);
  // Optional: it only tells Tidepool sooner. Its worker polls deposit addresses anyway.
  await tidepool.submitDeposit({ txHash, depositAddress }).catch((error: unknown) => console.log(`  (couldn't tell Tidepool about the deposit: ${String(error)}; it polls anyway)`));

  console.log("\n5. Waiting for Tidepool and Hyperliquid");
  let finalAt: number | null = null;
  const balanceWatch = waitForBalanceChange(() => readBalance(settings.hlAddress), before, {
    giveUpAt: () => (finalAt ?? depositAt + STATUS_TIMEOUT_MS) + BALANCE_TIMEOUT_MS,
  }).then((change) => {
    if (change) console.log(`  +${((change.at - depositAt) / 1000).toFixed(1)} s  Hyperliquid testnet balance now ${change.value} USDC`);
    return change;
  });
  const final = await waitForFinalStatus(() => tidepool.getStatus(depositAddress), {
    timeoutMs: STATUS_TIMEOUT_MS,
    onStatus: (s: SwapStatus, at: number) => console.log(`  +${((at - depositAt) / 1000).toFixed(1)} s  Tidepool: ${s}`),
  });
  finalAt = final.at;

  if (final.status !== "SUCCESS") {
    const raw = await fetch(statusLink(depositAddress)).then((r) => r.text()).catch((error: unknown) => String(error));
    console.log(`\nThe swap ended ${final.final ? final.status : `without a final status (last: ${final.status ?? "none"})`}. Tidepool's status response:\n${raw}`);
  }
  // Waits only while the swap could still pay out: a refund or failure won't move the balance.
  const change = final.status === "SUCCESS" ? await balanceWatch : null;

  console.log("\nSummary\n");
  console.log(
    formatSummary({
      quoteId: quote.quoteId,
      depositAddress,
      nearTxHash: txHash,
      status: final.status,
      balanceBefore: before,
      balanceAfter: change?.value ?? null,
      msToFinal: final.final ? final.at - depositAt : null,
      msToBalance: change ? change.at - depositAt : null,
    }),
  );
  console.log(`Hyperliquid account:  ${hlAccountLink(settings.hlAddress)}`);
  process.exit(final.status === "SUCCESS" && change !== null ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(`\nStopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
