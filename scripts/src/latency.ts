import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getHealth } from "@lifeline/hyperliquid";
import { connectNear, createNearVault, createOneClick, readLiveConfig } from "@lifeline/keeper";
import { formatReport, summarize, type DecisionSample, type FailedAttempt, type NearSample } from "./latency-report";
import { signTestnetQuote } from "./testnet-quote";

/**
 * Measures what can be measured without moving real money, and writes research/latency/.
 *   pnpm latency                      20 keeper-decision samples on mainnet APIs
 *   pnpm latency 30 --near-testnet 10 also 10 real rescue transactions on the testnet vault
 * --near-testnet reads .env, which must point at testnet, and sends 2 test USDC per sample.
 */

/** Live Hyperliquid accounts with open cross positions, seen in ETH trades on 2026-11-08. */
const ADDRESSES = [
  "0xfc2178237621b1ed667014212b9e525f8d3ca60e",
  "0xd93db9fc95c19c1eaab854281890e9e77b18ae3f",
  "0x4c6988b39fc0904628c2959e7606ef5f8518c152",
];
const ONECLICK_URL = "https://1click.chaindefuser.com";
const REFUND_TO = "demo.near"; // 1Click needs an existing account; the quotes are dry
const OUT_DIR = new URL("../../research/latency/", import.meta.url);
const SAMPLES_FILE = new URL("samples.json", OUT_DIR);
const GAP_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function decisionSample(index: number): Promise<DecisionSample> {
  let timeEstimateSec: number | null = null;
  // Reads 1Click's timeEstimate on the way past; the client itself doesn't keep it.
  const oneClick = createOneClick({
    apiUrl: ONECLICK_URL,
    nearSenderAccount: "vault.sim.near",
    fetch: (async (url: string, init?: RequestInit) => {
      const response = await fetch(url, init);
      const text = await response.text();
      try {
        const estimate = (JSON.parse(text) as { quote?: { timeEstimate?: unknown } }).quote?.timeEstimate;
        if (typeof estimate === "number") timeEstimateSec = estimate;
      } catch {
        // not JSON: the client reports it
      }
      return new Response(text, { status: response.status, headers: response.headers });
    }) as typeof fetch,
  });
  const address = ADDRESSES[index % ADDRESSES.length] as string;
  const params = { recipient: address, refundTo: REFUND_TO, dry: true };

  const t0 = performance.now();
  const read = await getHealth(address);
  const t1 = performance.now();
  await oneClick.getQuote({ ...params, amount: "3000000" });
  const t2 = performance.now();
  await oneClick.getQuote({ ...params, amount: "3500000" });
  const t3 = performance.now();
  await getHealth(address);
  const t4 = performance.now();
  if (read.status !== "ok") throw new Error(`Hyperliquid couldn't be read for ${address}`);

  return {
    at: new Date().toISOString(),
    address,
    readMs: Math.round(t1 - t0),
    probeMs: Math.round(t2 - t1),
    quoteMs: Math.round(t3 - t2),
    freshMs: Math.round(t4 - t3),
    totalMs: Math.round(t4 - t0),
    timeEstimateSec,
  };
}

async function nearSamples(count: number): Promise<{ samples: NearSample[]; failed: FailedAttempt[] }> {
  const config = readLiveConfig(process.env);
  if (config.network !== "testnet") throw new Error("--near-testnet needs .env to point at testnet");
  const client = connectNear(config);
  const vault = createNearVault(client, { keeperAccountId: config.keeperAccountId });
  const user = config.users[0] ?? (await vault.getUsers())[0];
  if (user === undefined) throw new Error("the testnet vault has no users");
  const policy = await vault.getPolicy(user);
  if (policy === null) throw new Error(`${user}'s policy doesn't name ${config.keeperAccountId}`);
  const [token] = (await client.view("get_tokens", {})) as string[];
  if (token === undefined) throw new Error("the testnet vault lists no token");
  const signer = process.env.TESTNET_QUOTE_SIGNER_KEY?.trim();
  if (!signer) throw new Error("--near-testnet needs TESTNET_QUOTE_SIGNER_KEY, the key the testnet vault trusts in place of 1Click's");

  const samples: NearSample[] = [];
  const failed: FailedAttempt[] = [];
  for (let i = 0; i < count; i++) {
    if (i > 0) await sleep((policy.cooldownSec + 2) * 1000);
    const depositAddress = randomBytes(32).toString("hex");
    const quote = signTestnetQuote({ key: signer, user, token, amount: "2000000", recipient: policy.hlAddress, depositAddress });
    const start = performance.now();
    try {
      const { txHash } = await vault.rescue({
        user,
        token,
        amount: "2000000",
        depositAddress,
        recipient: policy.hlAddress,
        quoteId: `latency-${Date.now()}`,
        quote: quote.payload,
        signature: quote.signature,
      });
      const ms = Math.round(performance.now() - start);
      samples.push({ at: new Date().toISOString(), txHash, ms, network: "testnet" });
      console.log(`  NEAR ${i + 1}/${count}: ${(ms / 1000).toFixed(2)} s  https://testnet.nearblocks.io/txns/${txHash}`);
    } catch (error) {
      // A public node drops the odd request. Count it and move on, rather than lose the run.
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ at: new Date().toISOString(), error: message });
      console.log(`  NEAR ${i + 1}/${count}: failed, ${message}`);
    }
  }
  return { samples, failed };
}

async function main() {
  const args = process.argv.slice(2);
  const nearFlag = args.indexOf("--near-testnet");
  const nearCount = nearFlag === -1 ? 0 : Number(args[nearFlag + 1] ?? 10);
  const count = Number(args.find((arg, i) => /^\d+$/.test(arg) && i !== nearFlag + 1) ?? 20);
  if (nearCount > 0) {
    const env = new URL("../../.env", import.meta.url);
    if (existsSync(env)) process.loadEnvFile(env);
  }

  const previous = existsSync(SAMPLES_FILE)
    ? (JSON.parse(readFileSync(SAMPLES_FILE, "utf8")) as { decisions: DecisionSample[]; near: NearSample[]; nearFailed?: FailedAttempt[] })
    : { decisions: [], near: [] };

  console.log(`Keeper decision on mainnet APIs, ${count} samples:`);
  const decisions: DecisionSample[] = [];
  const failed: FailedAttempt[] = [];
  for (let i = 0; i < count; i++) {
    try {
      const sample = await decisionSample(i);
      decisions.push(sample);
      console.log(`  ${i + 1}/${count}: ${(sample.totalMs / 1000).toFixed(2)} s`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ at: new Date().toISOString(), error: message });
      console.log(`  ${i + 1}/${count}: failed, ${message}`);
    }
    await sleep(GAP_MS);
  }
  let near = previous.near;
  let nearFailed: FailedAttempt[] = previous.nearFailed ?? [];
  if (nearCount > 0) {
    console.log(`\nRescue transactions on the testnet vault, ${nearCount} samples:`);
    ({ samples: near, failed: nearFailed } = await nearSamples(nearCount));
  }

  const generatedAt = new Date().toISOString();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(SAMPLES_FILE, `${JSON.stringify({ generatedAt, decisions, failed, near, nearFailed }, null, 2)}\n`);
  const report = formatReport(summarize(decisions, near, failed, nearFailed), generatedAt);
  writeFileSync(new URL("RESULTS.md", OUT_DIR), report);
  console.log(`\n${report}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
