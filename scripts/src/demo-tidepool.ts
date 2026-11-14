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
import { nearAccount, runProof } from "./proof-run";
import { AMOUNT, TIDEPOOL, depositActions, readSettings, tidepoolMinOut } from "./tidepool";

const env = new URL("../../.env", import.meta.url);
if (existsSync(env)) process.loadEnvFile(env);

const usdc = (units: string) => `${Number(units) / 1e6} USDC`;

async function main() {
  const settings = readSettings(process.argv.slice(2), process.env);
  console.log(`Lifeline on testnet through Tidepool${settings.dry ? " (dry run: nothing is sent)" : ""}\n`);
  return runProof({
    route: TIDEPOOL,
    dry: settings.dry,
    hlAddress: settings.hlAddress,
    refundTo: settings.nearAccount,
    withdrawFeeOptional: true,
    amount: async () => AMOUNT,
    describeAmount: (units) => `${usdc(units)} from NEAR testnet`,
    minAmountOut: tidepoolMinOut,
    async deposit(depositAddress, amount) {
      const near = nearAccount(TIDEPOOL, settings.nearAccount, settings.nearKey!);
      const balance = (await near.view<string>(TIDEPOOL.usdcContract, "ft_balance_of", { account_id: settings.nearAccount })) ?? "0";
      if (BigInt(balance) < BigInt(amount)) throw new Error(`${settings.nearAccount} holds ${usdc(balance)}, less than ${usdc(amount)}. Claim test USDC at https://app.usetidepool.tech/faucet first.`);
      const registered = await near.view<unknown>(TIDEPOOL.usdcContract, "storage_balance_of", { account_id: depositAddress });
      const bounds = await near.view<{ min: string }>(TIDEPOOL.usdcContract, "storage_balance_bounds", {});
      const steps = depositActions(depositAddress, amount, registered === null || registered === undefined ? BigInt(bounds.min) : null);
      console.log(`  ${settings.nearAccount} holds ${usdc(balance)}; sending ${usdc(amount)} to ${depositAddress} (${steps.map((s) => s.method).join(" + ")})`);
      return near.send(TIDEPOOL.usdcContract, steps);
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
