import { getHealth } from "@lifeline/hyperliquid";
import { createOneClick, type Intents, type Quote, type SwapStatus } from "@lifeline/intents";
import { Account, actions, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";
import { formatSummary, hlAccountLink, nearTxLink, quoteProblems, statusLink, waitForBalanceChange, waitForFinalStatus, type Route } from "./proof";

const STATUS_TIMEOUT_MS = 10 * 60_000;
/** After the swap is final, how long to wait for the USDC to show on Hyperliquid. */
const BALANCE_TIMEOUT_MS = 5 * 60_000;

export type ProofRun = {
  route: Route;
  dry: boolean;
  hlAddress: string;
  /** The NEAR account that pays, and that a failed swap refunds. */
  refundTo: string;
  jwt?: string;
  /** For a route that prices its fee into amountOut and sends no withdrawFee. */
  withdrawFeeOptional?: boolean;
  /** What to quote, in origin base units. It may ask the client for a dry quote to size it. */
  amount: (client: Intents) => Promise<string>;
  describeAmount: (units: string) => string;
  /** The least the signed quote may promise to deliver, in destination base units. */
  minAmountOut: (amount: string) => string;
  /** Checks what it needs to, pays the deposit address and returns the transaction. Throws to stop. */
  deposit: (depositAddress: string, amount: string) => Promise<string>;
};

/** A NEAR account to send from, and a contract view on the route's RPC. */
export function nearAccount(route: Route, accountId: string, key: string) {
  const provider = new JsonRpcProvider({ url: route.nearRpc });
  const account = new Account(accountId, provider, key as KeyPairString);
  const view = <T>(contractId: string, method: string, args: Record<string, unknown>) =>
    provider.callFunction<T & object>({ contractId, method, args }) as Promise<T>;
  /** One transaction of function calls to one contract, waited on until it executed. Throws if it failed on chain. */
  const send = async (receiverId: string, calls: { method: string; args: Record<string, unknown>; depositYocto: bigint; gasTgas: number }[]) => {
    const sent = await account.signAndSendTransaction({
      receiverId,
      actions: calls.map((c) => actions.functionCall(c.method, c.args, teraToGas(c.gasTgas), c.depositYocto)),
      waitUntil: "EXECUTED_OPTIMISTIC",
      throwOnFailure: false,
    });
    const status = sent.status as { Failure?: unknown } | string | undefined;
    if (typeof status === "object" && status?.Failure !== undefined) {
      throw new Error(`the deposit failed on chain: ${JSON.stringify(status.Failure)} (${nearTxLink(route, sent.transaction.hash)})`);
    }
    return sent.transaction.hash;
  };
  return { provider, account, view, send };
}

/** The Hyperliquid perps balance, read with packages/hyperliquid against the route's API. */
async function readBalance(route: Route, address: string): Promise<number> {
  const result = await getHealth(address, { apiUrl: route.hlApi });
  if (result.status !== "ok") throw new Error(`Hyperliquid: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
  return result.snapshot.accountValue;
}

/** Runs the proof and returns the exit code: 0 only when the swap succeeded and the balance moved. */
export async function runProof(run: ProofRun): Promise<number> {
  const { route } = run;
  const out = (units: string) => `${Number(units) / route.destinationUnit} USDC`;
  const client = createOneClick({
    apiUrl: route.apiUrl,
    nearSenderAccount: run.refundTo,
    quoteSigner: route.quoteSigner,
    originAsset: route.originAsset,
    destinationAsset: route.destinationAsset,
    ...(run.jwt ? { jwt: run.jwt } : {}),
    ...(run.withdrawFeeOptional ? { withdrawFeeOptional: true } : {}),
  });

  console.log("1. Hyperliquid balance");
  const before = await readBalance(route, run.hlAddress);
  console.log(`  ${run.hlAddress}: ${before} USDC (${hlAccountLink(route, run.hlAddress)})\n`);

  const amount = await run.amount(client);
  console.log(`2. A live quote from ${route.name}, ${run.describeAmount(amount)} to that perps balance`);
  // getQuote checks the signature against the route's key, and that every field asked for came back unchanged.
  const quote: Quote = await client.getQuote({ amount, recipient: run.hlAddress, refundTo: run.refundTo, dry: false });
  console.log(`  quote:      ${quote.quoteId} (${quote.quotedAt})`);
  console.log(`  pays:       ${run.describeAmount(quote.amountIn)}, at least ${out(quote.minAmountOut)} to ${quote.recipient}`);
  console.log(`  fee:        ${out(quote.withdrawFee)} flat, inside that minimum`);
  console.log(`  asset:      ${quote.destinationAsset}`);
  console.log(`  refunds:    ${quote.refundTo}`);
  console.log(`  deposit to: ${quote.depositAddress ?? "none"}`);

  console.log("\n3. Checks");
  console.log(`  signature:  valid, ${route.name}'s key ${route.quoteSigner}`);
  const minAmountOut = run.minAmountOut(amount);
  const problems = quoteProblems(quote, { recipient: run.hlAddress, refundTo: run.refundTo, amount, destinationAsset: route.destinationAsset, minAmountOut });
  if (problems.length > 0) {
    for (const problem of problems) console.log(`  REFUSED:    ${problem}`);
    console.log("\nStopping: nothing was sent.");
    return 1;
  }
  console.log(`  recipient, asset, amount in, minimum out (at least ${out(minAmountOut)}), refund account and deposit address: all as asked`);

  if (run.dry) {
    console.log("\nDry run: stopping before the deposit. Nothing was sent, and the quote's deposit address is never paid.");
    return 0;
  }

  const depositAddress = quote.depositAddress!;
  console.log("\n4. The deposit");
  const txHash = await run.deposit(depositAddress, amount);
  const depositAt = Date.now();
  console.log(`  sent: ${nearTxLink(route, txHash)}`);
  // Optional: it only tells the API sooner. It watches deposit addresses anyway.
  await client.submitDeposit({ txHash, depositAddress }).catch((error: unknown) => console.log(`  (couldn't submit the deposit: ${String(error)}; it's watched anyway)`));

  console.log(`\n5. Waiting for ${route.name} and Hyperliquid`);
  let finalAt: number | null = null;
  const balanceWatch = waitForBalanceChange(() => readBalance(route, run.hlAddress), before, {
    giveUpAt: () => (finalAt ?? depositAt + STATUS_TIMEOUT_MS) + BALANCE_TIMEOUT_MS,
  }).then((change) => {
    if (change) console.log(`  +${((change.at - depositAt) / 1000).toFixed(1)} s  Hyperliquid balance now ${change.value} USDC`);
    return change;
  });
  const final = await waitForFinalStatus(() => client.getStatus(depositAddress), {
    timeoutMs: STATUS_TIMEOUT_MS,
    onStatus: (s: SwapStatus, at: number) => console.log(`  +${((at - depositAt) / 1000).toFixed(1)} s  ${route.name}: ${s}`),
  });
  finalAt = final.at;

  if (final.status !== "SUCCESS") {
    const raw = await fetch(statusLink(route, depositAddress), run.jwt ? { headers: { authorization: `Bearer ${run.jwt}` } } : {})
      .then((r) => r.text())
      .catch((error: unknown) => String(error));
    console.log(`\nThe swap ended ${final.final ? final.status : `without a final status (last: ${final.status ?? "none"})`}. ${route.name}'s status response:\n${raw}`);
  }
  // Waits only while the swap could still pay out: a refund or failure won't move the balance.
  const change = final.status === "SUCCESS" ? await balanceWatch : null;

  console.log("\nSummary\n");
  console.log(
    formatSummary(route, {
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
  console.log(`Hyperliquid account:  ${hlAccountLink(route, run.hlAddress)}`);
  return final.status === "SUCCESS" && change !== null ? 0 : 1;
}
