import { getMidPrice } from "@lifeline/hyperliquid";
import {
  AttestationMonitor,
  checkAttestationWithSigners,
  createExplainer,
  createOneClick,
  createRecordPipeline,
  DEFAULT_NEAR_AI_MODEL,
  DEFAULT_NEAR_AI_URL,
  describeRecord,
  nodeIntel,
  openStore,
  runSim,
  SIM_USER,
} from "@lifeline/keeper";
import { describeAudit, describeQuote } from "./demo-format";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = () => new Date();

/**
 * The real keeper, policy engine and 1Click quotes, on a pretend account. It needs no
 * wallet, keys or funds. Real: the opening price, every quote, every decision.
 * Pretend: the account, the price drop, and the settlement after the engine says yes.
 */
async function main() {
  console.log("Lifeline demo. No wallet, no keys, no funds.\n");
  const startPrice = await getMidPrice("ETH");
  console.log(`Live ETH price from Hyperliquid: $${startPrice.toLocaleString("en-US")}`);
  console.log("Pretend account: 10× long, $300 of ETH, $30 margin, 100 USDC reserve.");
  console.log("Policy: warn at health 1.8, rescue below 1.5, back up to 2.0, at most 25 USDC per rescue.\n");
  console.log("Now the price is shocked down, one step a second:\n");

  const store = openStore(":memory:");
  const log = (line: string) => console.log(`  (${line})`);
  const nearAi = {
    baseUrl: process.env.NEAR_AI_BASE_URL?.trim() || DEFAULT_NEAR_AI_URL,
    apiKey: process.env.NEAR_AI_API_KEY?.trim() || null,
    model: process.env.NEAR_AI_MODEL?.trim() || DEFAULT_NEAR_AI_MODEL,
  };
  // With a key, the model's words are kept only if their signature verifies against the
  // attested key, so the hardware is checked once first. Without one, the facts alone.
  const attestation = new AttestationMonitor(
    () => checkAttestationWithSigners({ ...nearAi, now: () => new Date(), intel: nodeIntel }),
    { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  );
  if (nearAi.apiKey !== null) {
    console.log("Checking NEAR AI Cloud's hardware attestation, so the model's answers can be verified…");
    await attestation.refreshIfDue(Date.now());
    console.log(`  ${attestation.latest().status}, ${attestation.signers().length} signing key(s) verified\n`);
  }
  const explainer = createExplainer({ ...nearAi, log, signers: () => attestation.signers() });
  const pipeline = createRecordPipeline({
    store,
    explain: (record) => explainer.explain(record),
    notify: async ({ explanation }) => {
      if (explanation) console.log(`    "${explanation}"`);
    },
    log,
  });

  const oneClick = createOneClick({
    apiUrl: process.env.ONECLICK_API_URL?.trim() || "https://1click.chaindefuser.com",
    nearSenderAccount: "vault.sim.near",
  });
  let quotes = 0;
  const result = await runSim({
    store,
    quotes: {
      async getQuote(params) {
        const quote = await oneClick.getQuote(params);
        quotes += 1;
        // The first only reads the live fee, to size the second.
        if (quotes === 2) console.log(`  Real 1Click dry quote: ${describeQuote(quote)}`);
        return quote;
      },
    },
    now,
    sleep,
    // Quiet, except for why a rescue had to wait: the demo holds the price while it retries.
    log: (line) => {
      if (line.includes("couldn't start")) console.log(`  (keeper: ${line}. It tries again in 30 s.)`);
    },
    startPrice,
    onTick: (price, health) => console.log(`ETH $${price.toFixed(2)}  health ${health.toFixed(2)}`),
    onRecord: (record) => {
      console.log(`  ${describeRecord(record)}`);
      if (record.decision) console.log(`    Policy engine: ${record.decision.verdict}, ${record.decision.reasons.length} rules broken`);
      pipeline.handle(record);
    },
  });
  await pipeline.settled();

  const done = store.latest(SIM_USER, "RESCUE_DONE");
  console.log("\nThe audit record:\n");
  if (done) console.log(describeAudit(done));
  console.log(`\nReserve: ${Number(result.reserveBefore) / 1e6} to ${Number(result.reserveAfter) / 1e6} USDC.`);
  console.log("The settlement is pretend, so this latency isn't a real measurement.");
  store.close();

  const passed = result.sent.length === 1 && done !== null;
  console.log(passed ? "\nPASS: exactly one rescue." : `\nFAIL: expected one rescue, got ${result.sent.length}.`);
  process.exitCode = passed ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(`\nThe demo couldn't run, and it needs internet access: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
