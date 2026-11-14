import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connectNear, createNearVault, createOneClick, readLiveConfig, type Quote } from "@lifeline/keeper";
import { ASSETS, POLICY_DEFAULTS } from "@lifeline/shared";
import { ATTACKER_HL, checkProofOnNodes, explorerFor, formatAttempt, parseProof, proofRpcs, runEngineAttacks, sendContractAttack } from "./attack";
import { signTestnetQuote } from "./testnet-quote";

const PROOF_FILE = new URL("../attack-proof.json", import.meta.url);
/** The same attack on the testnet vault, until a human agrees to the mainnet one. */
const TESTNET_PROOF_FILE = new URL("../attack-proof-testnet.json", import.meta.url);
const SEND_MAINNET = "--send-mainnet";
const SEND_TESTNET = "--send-testnet";
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

/**
 * Sends the attack with the keeper's own key and saves the refusal. On mainnet the quote
 * is a real one from 1Click, for the user's own address; on testnet, where 1Click doesn't
 * run, the stand-in key the testnet vault trusts signs it. Reads .env.
 */
async function sendAndRecord(network: "mainnet" | "testnet") {
  const env = new URL("../../.env", import.meta.url);
  if (existsSync(env)) process.loadEnvFile(env);
  const config = readLiveConfig(process.env);
  if (config.network !== network) throw new Error(`--send-${network} needs NEAR_NETWORK=${network} in .env`);
  const client = connectNear(config);
  const vault = createNearVault(client, { keeperAccountId: config.keeperAccountId });
  const user = config.users[0] ?? (await vault.getUsers())[0];
  if (user === undefined) throw new Error("the vault has no user to attack");
  const policy = await vault.getPolicy(user);
  if (policy === null) throw new Error(`${user}'s policy doesn't name ${config.keeperAccountId}`);
  const [token] = (await client.view("get_tokens", {})) as string[];
  if (token === undefined) throw new Error("the vault lists no token");
  const amount = "3000000";

  let quote: { payload: string; signature: string } | undefined;
  if (network === "mainnet") {
    const oneClick = createOneClick({ apiUrl: ONECLICK_URL, nearSenderAccount: config.vaultId });
    quote = (await oneClick.getQuote({ amount, recipient: policy.hlAddress, refundTo: user, dry: false })).signed;
  } else {
    const key = process.env.TESTNET_QUOTE_SIGNER_KEY?.trim();
    if (!key) throw new Error("--send-testnet needs TESTNET_QUOTE_SIGNER_KEY");
    quote = signTestnetQuote({ key, user, token, amount, recipient: policy.hlAddress, depositAddress: randomBytes(32).toString("hex") });
  }
  if (quote === undefined) throw new Error("1Click gave no signed quote");

  const details = { network, vaultId: config.vaultId, keeperAccountId: config.keeperAccountId, user, token, hlAddress: policy.hlAddress, amount, quote };
  const proof = await sendContractAttack(client, details, now);
  const file = network === "mainnet" ? PROOF_FILE : TESTNET_PROOF_FILE;
  writeFileSync(file, `${JSON.stringify(proof, null, 2)}\n`);
  console.log(`Sent, refused and saved: ${proof.txHash}\n`);
}

async function main() {
  if (process.argv.includes(SEND_MAINNET)) await sendAndRecord("mainnet");
  if (process.argv.includes(SEND_TESTNET)) await sendAndRecord("testnet");

  console.log("Lifeline attack demo: a hacked or prompt-injected keeper tries to steal a user's reserve.\n");
  console.log("Layer 1: the keeper's policy engine. Quotes are real and dry, so no funds can move.\n");
  const oneClick = createOneClick({ apiUrl: ONECLICK_URL, nearSenderAccount: "vault.sim.near" });
  const attempts = await runEngineAttacks({ quotes: oneClick, tamperedQuote, now });
  for (const attempt of attempts) console.log(formatAttempt(attempt));
  const layer1Held = attempts.every((attempt) => attempt.outcome === attempt.expected);

  console.log("\nLayer 2: the vault contract. A hacked keeper could skip layer 1, so its key calls rescue itself: the user's real address as recipient, a correctly signed quote, and its own account as where the money goes. (On testnet the vault trusts a team key in place of 1Click's, since 1Click has no testnet.)\n");
  let layer2Failed = false;
  const read = (file: URL) => (existsSync(file) ? parseProof(readFileSync(file, "utf8")) : null);
  const proof = read(PROOF_FILE) ?? read(TESTNET_PROOF_FILE);
  if (proof === null) {
    console.log("NOT RUN YET. It needs a deployed vault, and on mainnet a human's go-ahead, because it sends a real transaction.");
  } else {
    const result = await checkProofOnNodes(proof, proofRpcs(proof.network));
    layer2Failed = !result.refused;
    console.log(result.refused ? `REFUSED      by the vault contract on ${proof.network}, re-checked on chain just now` : `NOT CONFIRMED  ${result.detail}`);
    console.log(`             transaction: ${explorerFor(proof)}`);
    if (result.refused) console.log(`             ${result.detail}`);
    if (proof.network === "testnet") console.log("             The mainnet run waits for the mainnet vault and a human's go-ahead.");
  }

  console.log(`\nWhat this doesn't stop: the vault can't see Hyperliquid, so a hacked keeper could still move a reserve into the user's own Hyperliquid account when no rescue is needed, up to ${money(POLICY_DEFAULTS.maxPerRescue)} USDC per rescue and ${money(POLICY_DEFAULTS.maxPerDay)} USDC a day. The money stays the user's, and they can pause or withdraw at any time. It's listed under Limitations in the README.`);

  const passed = layer1Held && !layer2Failed;
  console.log(passed ? "\nPASS: every attack that ran was refused, and the honest rescue was allowed." : "\nFAIL: see NOT REFUSED above.");
  process.exitCode = passed ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(`\nThe demo couldn't run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
