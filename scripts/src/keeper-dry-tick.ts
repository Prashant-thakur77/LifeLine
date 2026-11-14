/**
 * One keeper tick against the mainnet vault, with nothing sent. It runs the real Keeper:
 * the vault's reads, Hyperliquid's health, the sizing, a dry and a live 1Click quote and
 * the policy engine. At the vault's `rescue` it stops: the call is captured and refused
 * here, and the NEAR client holds a throwaway key that couldn't sign for the keeper anyway.
 * The captured call is then checked against the vault's own rules (lib.rs `rescue` and
 * quote.rs `check`), off chain; the vault checks them again itself when the rescue is real.
 */
import { randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { getHealth } from "@lifeline/hyperliquid";
import { ONE_CLICK_QUOTE_SIGNER, signerKeyBytes } from "@lifeline/intents";
import { Keeper, VaultRejectedError, connectNear, createNearVault, createOneClick, openStore, type RescueArgs } from "@lifeline/keeper";
import { KeyPair } from "near-api-js";

const VAULT = "vault.lifeline-hq.near";
const KEEPER = "keeper.lifeline-hq.near";
const HL_USDC = "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054";
const USER = process.argv[2] ?? "";
if (!/^[0-9a-f]{64}$/.test(USER)) throw new Error("usage: keeper-dry-tick.ts <implicit account>");

/** The vault's quote rules (quote.rs `check`) and `rescue`'s preconditions, as named checks. */
export function vaultChecks(args: RescueArgs, policy: { hlAddress: string; maxPerRescue: string; paused?: boolean }, nowMs: number, reserve: string) {
  const fields = JSON.parse(args.quote) as Record<string, unknown>;
  const text = (name: string) => (typeof fields[name] === "string" ? (fields[name] as string) : undefined);
  const amount = BigInt(args.amount);
  const value = amount * 100n; // 6-decimal USDC in, 8-decimal out
  const out = BigInt(text("amountOut") ?? "0");
  const min = BigInt(text("minAmountOut") ?? "0");
  const fee = BigInt(text("withdrawFee") ?? "-1");
  const at = Date.parse(text("timestamp") ?? "");
  const hash = new TextEncoder().encode(base58.encode(sha256(new TextEncoder().encode(args.quote))));
  const signedBy1Click = (() => {
    try {
      return ed25519.verify(base58.decode(args.signature.replace(/^ed25519:/, "")), hash, signerKeyBytes(ONE_CLICK_QUOTE_SIGNER), { zip215: false });
    } catch {
      return false;
    }
  })();
  return [
    ["signed by 1Click's key (BAD_QUOTE)", signedBy1Click],
    ["recipient is the policy's Hyperliquid address (RECIPIENT_MISMATCH)", args.recipient.toLowerCase() === policy.hlAddress.toLowerCase()],
    ["amount above 0 and within max_per_rescue (OVER_PER_RESCUE)", amount > 0n && amount <= BigInt(policy.maxPerRescue)],
    ["the reserve covers it (INSUFFICIENT_RESERVE)", amount <= BigInt(reserve)],
    ["token is the rescue token, native USDC (UNKNOWN_TOKEN)", args.token === "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"],
    ["not a dry quote", fields.dry === false],
    ["EXACT_INPUT, ORIGIN_CHAIN deposit, DESTINATION_CHAIN payout", text("swapType") === "EXACT_INPUT" && text("depositType") === "ORIGIN_CHAIN" && text("recipientType") === "DESTINATION_CHAIN"],
    ["origin asset is that token", text("originAsset") === `nep141:${args.token}`],
    ["destination is Hyperliquid perps USDC", text("destinationAsset") === HL_USDC],
    ["amount and amountIn equal the rescue's amount", text("amount") === args.amount && text("amountIn") === args.amount],
    ["refunds the user's own NEAR account, ORIGIN_CHAIN", text("refundTo") === args.user && text("refundType") === "ORIGIN_CHAIN"],
    ["no redirecting field", !["virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg", "depositMemo"].some((k) => k in fields)],
    ["flat fee at most 1 USDC, and at most a fifth of the rescue", fee >= 0n && fee <= 100_000_000n && fee * 5n <= value],
    ["delivers at least 99.7% of what's sent, beyond the flat fee", out + fee >= (value / 10_000n) * (10_000n - 30n)],
    ["slippage floor within 1% of its price, and slippageTolerance ≤ 1%", out - min <= (value / 10_000n) * 100n && typeof fields.slippageTolerance === "number" && fields.slippageTolerance <= 100],
    ["quote pays this exact deposit address", text("depositAddress") === args.depositAddress],
    ["at most 2 minutes old, not dated in the future", Number.isFinite(at) && nowMs - at <= 120_000 && at - nowMs <= 30_000],
    ["quote id 1 to 128 characters", args.quoteId.length >= 1 && args.quoteId.length <= 128],
  ] as const;
}

async function main() {
  const provider = connectNear({ rpcUrl: "https://free.rpc.fastnear.com", vaultId: VAULT, keeperAccountId: KEEPER, keeperKey: KeyPair.fromRandom("ed25519").toString() });
  const vault = createNearVault(provider, { keeperAccountId: KEEPER });
  let captured: RescueArgs | null = null;
  const dryVault = {
    ...vault,
    async rescue(args: RescueArgs): Promise<{ txHash: string }> {
      captured = args;
      throw new VaultRejectedError("DRY RUN: the keeper's rescue call was captured and not sent");
    },
  };
  const logs: string[] = [];
  const store = openStore(":memory:");
  const jwt = process.env.ONECLICK_JWT?.trim();
  const keeper = new Keeper({
    store,
    vault: dryVault,
    intents: createOneClick({ apiUrl: "https://1click.chaindefuser.com", nearSenderAccount: VAULT, ...(jwt && !jwt.startsWith("fake") ? { jwt } : {}) }),
    readHealth: (address) => getHealth(address, { apiUrl: "https://api.hyperliquid.xyz" }),
    users: () => [USER],
    now: () => new Date(),
    sleep: async () => {},
    newId: randomUUID,
    dryQuotes: false,
    log: (line) => logs.push(line),
    onRecord: (record) => logs.push(`record ${record.kind}${record.explanation ? `: ${record.explanation}` : ""}`),
  });

  const policy = await vault.getPolicy(USER);
  const reserve = await vault.getReserve(USER, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  const health = await getHealth(policy!.hlAddress, { apiUrl: "https://api.hyperliquid.xyz" });
  console.log(`policy: trigger ${policy!.trigger}, target ${policy!.target}, max per rescue ${policy!.maxPerRescue}, keeper ${KEEPER}; reserve ${reserve}`);
  console.log(`health now: ${health.status === "ok" ? health.snapshot.health.toFixed(4) : health.status} (account value ${health.status === "ok" ? health.snapshot.accountValue : "?"} / maintenance ${health.status === "ok" ? health.snapshot.maintenanceMarginUsed : "?"})\n`);

  await keeper.tick();
  await keeper.settled();
  for (const line of logs) console.log(`keeper: ${line}`);
  const records = store.audit(USER, 10);
  const allowed = records.find((r) => r.kind === "RESCUE_ALLOWED");
  if (!captured || !allowed?.request || !allowed.decision) {
    console.log("\nRescue: NO. The keeper didn't reach the vault's rescue call.");
    return;
  }
  const args = captured as RescueArgs;
  const { request, decision } = allowed;
  console.log(`\nRescue: YES. The keeper would call ${VAULT}.rescue with:`);
  console.log(`  amount ${args.amount} base units (${Number(args.amount) / 1e6} USDC), token ${args.token}`);
  console.log(`  recipient ${args.recipient}, deposit address ${args.depositAddress}`);
  const signed = JSON.parse(args.quote) as { amountIn: string; amountOut: string; minAmountOut: string; withdrawFee: string; timestamp: string };
  console.log(`  1Click quote ${args.quoteId} (${signed.timestamp}): in ${signed.amountIn} USDC base units (request ${request.amount}), out ${signed.amountOut}, minimum out ${signed.minAmountOut} (8 decimals: ${Number(signed.minAmountOut) / 1e8} USDC), flat fee ${Number(signed.withdrawFee) / 1e8} USDC`);
  console.log(`\nPolicy engine (the keeper's layer 1): ${decision.verdict}${decision.reasons.length ? `, reasons: ${decision.reasons.join(", ")}` : ", no rule failed"}`);
  console.log(`\nThe vault's rules (layer 2), re-checked off chain on the captured call:`);
  for (const [name, ok] of vaultChecks(args, { hlAddress: policy!.hlAddress, maxPerRescue: policy!.maxPerRescue }, Date.now(), reserve)) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log("  (On chain the vault also checks: the caller is the user's keeper, the user isn't paused, the 24 h cap and cooldown, and that the deposit address was never paid. The policy engine checked those above.)");
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
