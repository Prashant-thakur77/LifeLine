/**
 * The same proof as demo:tidepool, on mainnet with real money: a signed 1Click quote from
 * wNEAR on NEAR to a Hyperliquid perps balance, checked against 1Click's own key, paid from
 * a NEAR implicit account, and watched until the USDC shows on Hyperliquid.
 *
 *   pnpm demo:mainnet --dry    read, size, quote, check. Sends nothing.
 *   pnpm demo:mainnet --send   the real run: wraps and sends at most 1.5 NEAR. Reads .env.
 */
import { existsSync } from "node:fs";
import { MAINNET, MIN_OUT, ONE_NEAR, checkReserve, formatNear, readMainnetSettings, sizeAmount, wrapAndDepositActions } from "./mainnet";
import { nearAccount, runProof } from "./proof-run";

const env = new URL("../../.env", import.meta.url);
if (existsSync(env)) process.loadEnvFile(env);

/** An account's liquid NEAR, in yocto, from the route's public RPC. */
async function nativeBalance(accountId: string): Promise<bigint> {
  const response = await fetch(MAINNET.nearRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as { result?: { amount: string }; error?: { cause?: { name?: string } } };
  if (body.result === undefined) throw new Error(`couldn't read ${accountId} on mainnet: ${body.error?.cause?.name ?? "no answer"}. Has its NEAR arrived?`);
  return BigInt(body.result.amount);
}

async function main() {
  const settings = readMainnetSettings(process.argv.slice(2), process.env);
  // Optional: 1Click charges less with a partner JWT. The placeholder in .env.example isn't one.
  const jwt = process.env.ONECLICK_JWT?.trim();
  const realJwt = jwt && !jwt.startsWith("fake") ? jwt : undefined;

  console.log(`Lifeline on MAINNET through 1Click${settings.dry ? " (dry run: nothing is sent)" : ": this spends real NEAR"}\n`);
  const balance = await nativeBalance(settings.nearAccount);
  console.log(`0. ${settings.nearAccount} holds ${formatNear(balance)} NEAR on mainnet\n`);

  return runProof({
    route: MAINNET,
    dry: settings.dry,
    hlAddress: settings.hlAddress,
    refundTo: settings.nearAccount,
    ...(realJwt ? { jwt: realJwt } : {}),
    async amount(client) {
      // A dry quote for 1 wNEAR sizes the live one; createOneClick checks its signature too.
      const sample = await client.getQuote({ amount: ONE_NEAR.toString(), recipient: settings.hlAddress, refundTo: settings.nearAccount, dry: true });
      const amount = sizeAmount(sample);
      console.log(`  sizing: 1 wNEAR quotes at least ${Number(sample.minAmountOut) / 1e8} USDC after a ${Number(sample.withdrawFee) / 1e8} USDC fee, so ${formatNear(BigInt(amount))} wNEAR for about 3.5 USDC out\n`);
      return amount;
    },
    describeAmount: (units) => `${formatNear(BigInt(units))} wNEAR`,
    minAmountOut: () => MIN_OUT.toString(),
    async deposit(depositAddress, amount) {
      const near = nearAccount(MAINNET, settings.nearAccount, settings.nearKey!);
      const wnearBalance = (await near.view<string>(MAINNET.wnear, "ft_balance_of", { account_id: settings.nearAccount })) ?? "0";
      const registered = async (accountId: string) => {
        const storage = await near.view<unknown>(MAINNET.wnear, "storage_balance_of", { account_id: accountId });
        return storage !== null && storage !== undefined;
      };
      const bounds = await near.view<{ min: string }>(MAINNET.wnear, "storage_balance_bounds", {});
      const steps = wrapAndDepositActions({
        account: settings.nearAccount,
        depositAddress,
        amount,
        wnearBalance,
        accountRegistered: await registered(settings.nearAccount),
        depositRegistered: await registered(depositAddress),
        storageYocto: BigInt(bounds.min),
      });
      // Read again just before sending, so the reserve check uses the balance as it is now.
      const left = checkReserve(await nativeBalance(settings.nearAccount), steps);
      console.log(`  one transaction on ${MAINNET.wnear}: ${steps.map((s) => s.method).join(" + ")}, leaving about ${formatNear(left)} NEAR`);
      return near.send(MAINNET.wnear, steps);
    },
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`\nStopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
