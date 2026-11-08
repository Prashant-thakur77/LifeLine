import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { createLifelineBot } from "@lifeline/bot";
import { getHealth } from "@lifeline/hyperliquid";
import { createLinkLimiter, NOT_AVAILABLE_ATTESTATION } from "./api";
import { createApi } from "./api-node";
import { AttestationMonitor, checkAttestation } from "./attestation";
import { DEFAULT_NEAR_AI_MODEL, DEFAULT_NEAR_AI_URL, parseMode, readLiveConfig, type LiveConfig } from "./config";
import { createExplainer } from "./explain";
import { nodeIntel } from "./intel-node";
import { describeRecord } from "./format";
import { Keeper } from "./keeper";
import { connectNear, createNearVault } from "./near";
import { canRescue, createUserList } from "./users";
import { createOneClick } from "@lifeline/intents";
import { createRecordPipeline } from "./pipeline";
import { runSim, SIM_USER } from "./sim";
import { openStore } from "./sql-node";

const SHUTDOWN_DRAIN_MS = 5_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = () => new Date();
const listen = (server: Server, port: number) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve((server.address() as AddressInfo).port));
  });

async function runSimCli(): Promise<number> {
  console.log("Lifeline keeper, sim mode. No wallet, no keys, no funds: only the quotes are real, and they're dry.\n");
  const store = openStore(":memory:");
  const api = createApi({
    store,
    now,
    botUsername: null,
    attestation: () => NOT_AVAILABLE_ATTESTATION,
    corsOrigin: "*",
  });
  const port = await listen(api, 0);
  console.log(`API: http://127.0.0.1:${port}/api/stats\n`);

  // A key is optional here: with none, explanations come from the template.
  const explainer = createExplainer({
    baseUrl: process.env.NEAR_AI_BASE_URL?.trim() || DEFAULT_NEAR_AI_URL,
    apiKey: process.env.NEAR_AI_API_KEY?.trim() || null,
    model: process.env.NEAR_AI_MODEL?.trim() || DEFAULT_NEAR_AI_MODEL,
    log: (line) => console.log(`  (${line})`),
  });
  const pipeline = createRecordPipeline({
    store,
    explain: (record) => explainer.explain(record),
    notify: async ({ explanation }) => {
      if (explanation) console.log(`    ${explanation}`);
    },
    log: (line) => console.log(`  (${line})`),
  });

  const result = await runSim({
    store,
    quotes: createOneClick({
      apiUrl: process.env.ONECLICK_API_URL?.trim() || "https://1click.chaindefuser.com",
      nearSenderAccount: "vault.sim.near",
    }),
    now,
    sleep,
    log: () => {},
    onTick: (price, health) => console.log(`ETH ${price.toFixed(0)}  health ${health.toFixed(2)}`),
    onRecord: (record) => {
      console.log(`  ${describeRecord(record)}`);
      pipeline.handle(record);
    },
  });
  await pipeline.settled();

  const stats = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
  const done = store.ledger(100).filter((record) => record.kind === "RESCUE_DONE");
  console.log(`\nAudit records for ${SIM_USER}: ${store.audit(SIM_USER, 100).length}`);
  console.log(`Reserve: ${Number(result.reserveBefore) / 1e6} to ${Number(result.reserveAfter) / 1e6} USDC`);
  console.log("From the API:", JSON.stringify(stats));
  console.log("Settlement is simulated, so this latency isn't a real measurement.");

  await new Promise((resolve) => api.close(resolve));
  store.close();
  const passed = result.sent.length === 1 && done.length === 1;
  console.log(passed ? "\nPASS: exactly one rescue." : `\nFAIL: expected one rescue, got ${result.sent.length} sent and ${done.length} finished.`);
  return passed ? 0 : 1;
}

async function runLive(config: LiveConfig): Promise<void> {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = openStore(config.dbPath);
  const log = (line: string) => console.log(`${now().toISOString()} ${line}`);
  const telegram =
    config.botToken === null
      ? null
      : createLifelineBot({ token: config.botToken, store, dashboardUrl: config.dashboardUrl, network: config.network, now, log });
  const explainer = createExplainer({ baseUrl: config.nearAiUrl, apiKey: config.nearAiKey, model: config.nearAiModel, log });
  const pipeline = createRecordPipeline({
    store,
    explain: (record) => explainer.explain(record),
    notify: async (record) => telegram?.notify(record),
    log,
  });
  const attestation = new AttestationMonitor(
    () => checkAttestation({ baseUrl: config.nearAiUrl, model: config.nearAiModel, apiKey: config.nearAiKey, now, intel: nodeIntel }),
    { sleep },
  );
  const vault = createNearVault(connectNear(config), { keeperAccountId: config.keeperAccountId });
  const userList = createUserList({ fixed: config.users, load: () => vault.getUsers(), accept: canRescue(vault), now: () => Date.now(), log });
  const keeper = new Keeper({
    store,
    vault,
    intents: createOneClick({
      apiUrl: config.oneClickUrl,
      nearSenderAccount: config.vaultId,
      ...(config.oneClickJwt ? { jwt: config.oneClickJwt } : {}),
    }),
    readHealth: (address) => getHealth(address),
    users: () => userList.users(),
    now,
    sleep,
    newId: randomUUID,
    dryQuotes: false,
    log,
    onRecord: (record) => {
      log(`${record.user}: ${describeRecord(record)}`);
      pipeline.handle(record);
    },
  });
  const api = createApi({
    store,
    now,
    botUsername: config.botUsername,
    attestation: () => attestation.latest(),
    corsOrigin: config.corsOrigin,
    allowLink: createLinkLimiter(),
  });

  const shutdown = async () => {
    keeper.stop();
    attestation.stop();
    telegram?.stopPolling();
    api.close();
    // Give messages and explanations a moment. A restart backfills any explanation it misses.
    await Promise.race([pipeline.settled(), sleep(SHUTDOWN_DRAIN_MS)]);
    store.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  const port = await listen(api, config.port);
  const extra = config.users.length > 0 ? `${config.users.join(", ")} and ` : "";
  console.log(`Lifeline keeper, live on ${config.network}, watching ${extra}everyone registered in ${config.vaultId}. API on port ${port}.`);
  void telegram?.poll();
  void attestation.run();
  pipeline.backfill();
  keeper.recover();
  await keeper.run();
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch {
    // No .env file: the settings can come from the environment itself.
  }
  const mode = parseMode(process.argv.slice(2));
  if (mode === "sim") process.exitCode = await runSimCli();
  else await runLive(readLiveConfig(process.env));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
