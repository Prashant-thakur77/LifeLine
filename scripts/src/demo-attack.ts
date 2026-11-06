import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connectNear, createOneClick, readLiveConfig, type Quote } from "@lifeline/keeper";
import { ASSETS, POLICY_DEFAULTS } from "@lifeline/shared";
import { ATTACKER_HL, checkProof, formatAttempt, parseProof, runEngineAttacks, sendContractAttack } from "./attack";

const PROOF_FILE = new URL("../attack-proof.json", import.meta.url);
const PUBLIC_MAINNET_RPC = "https://free.rpc.fastnear.com";
const SEND_FLAG = "--send-mainnet";
const ONECLICK_URL = "https://1click.chaindefuser.com";
const now = () => new Date();

const money = (units: string) => Number(units) / 10 ** ASSETS.NEAR_USDC.decimals;

/** Real 1Click, except the answer is altered after signing, as someone in the middle would. */
async function tamperedQuote(): Promise<Quote> {
  const oneClick = createOneClick({
    apiUrl: ONECLICK_URL,
    nearSenderAccount: "vault.sim.near",
    fetch: (async (url: string, init?: RequestInit) => {
      const response = await fetch(url, init);
      const body = (await response.json()) as { quoteRequest?: { recipient?: string } };
      if (body.quoteRequest) body.quoteRequest.recipient = ATTACKER_HL;
      return new Response(JSON.stringify(body), { status: response.status });
    }) as typeof fetch,
  });
  return oneClick.getQuote({ amount: "5000000", recipient: "0x1111111111111111111111111111111111111111", refundTo: "demo.near", dry: true });
}

async function sendAndRecord() {
  const config = readLiveConfig(process.env);
  if (config.network !== "mainnet") throw new Error(`${SEND_FLAG} needs NEAR_NETWORK=mainnet`);
  const user = config.users[0];
  if (user === undefined) throw new Error("KEEPER_USERS names no account to attack");
  const proof = await sendContractAttack(connectNear(config), { vaultId: config.vaultId, keeperAccountId: config.keeperAccountId, user, token: ASSETS.NEAR_USDC.contractId }, now);
  writeFileSync(PROOF_FILE, `${JSON.stringify(proof, null, 2)}\n`);
  console.log(`Sent, refused and saved to scripts/attack-proof.json: ${proof.txHash}\n`);
}

async function main() {
  if (process.argv.includes(SEND_FLAG)) await sendAndRecord();

  console.log("Lifeline attack demo: a hacked or prompt-injected keeper tries to steal a user's reserve.\n");
  console.log("Layer 1: the keeper's policy engine. Quotes are real and dry, so no funds can move.\n");
  const oneClick = createOneClick({ apiUrl: ONECLICK_URL, nearSenderAccount: "vault.sim.near" });
  const attempts = await runEngineAttacks({ quotes: oneClick, tamperedQuote, now });
  for (const attempt of attempts) console.log(formatAttempt(attempt));
  const layer1Held = attempts.every((attempt) => attempt.outcome === attempt.expected);

  console.log("\nLayer 2: the vault contract on mainnet. A hacked keeper could skip layer 1, so its key calls rescue directly with the attacker as recipient.\n");
  let layer2Failed = false;
  const proof = existsSync(PROOF_FILE) ? parseProof(readFileSync(PROOF_FILE, "utf8")) : null;
  if (proof === null) {
    console.log("NOT RUN YET. It needs the mainnet vault and a human's go-ahead, because it sends a real transaction.");
  } else {
    const result = await checkProof(proof, PUBLIC_MAINNET_RPC);
    layer2Failed = !result.refused;
    console.log(result.refused ? `REFUSED      by the vault contract, re-checked on chain just now` : `NOT CONFIRMED  ${result.detail}`);
    console.log(`             transaction: https://nearblocks.io/txns/${proof.txHash}`);
    if (result.refused) console.log(`             ${result.detail}`);
  }

  console.log(`\nWhat this doesn't stop: the contract can't read a quote, so a hacked keeper could get a quote that pays itself and still name the user as recipient. The caps limit that loss to ${money(POLICY_DEFAULTS.maxPerRescue)} USDC per rescue and ${money(POLICY_DEFAULTS.maxPerDay)} USDC per day, and the user can pause or withdraw at any time. It's listed under Limitations in the README.`);

  const passed = layer1Held && !layer2Failed;
  console.log(passed ? "\nPASS: every attack that ran was refused, and the honest rescue was allowed." : "\nFAIL: see NOT REFUSED above.");
  process.exitCode = passed ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(`\nThe demo couldn't run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
