import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { createLifelineBot } from "@lifeline/bot";
import { getHealth } from "@lifeline/hyperliquid";
import { createApi, NOT_AVAILABLE_ATTESTATION } from "./api";
import { parseMode, readLiveConfig, type LiveConfig } from "./config";
import { describeRecord } from "./format";
import { Keeper } from "./keeper";
import { connectNear, createNearVault } from "./near";
import { createOneClick } from "./oneclick";
import { runSim, SIM_USER } from "./sim";
import { Store } from "./store";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = () => new Date();
const listen = (server: Server, port: number) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve((server.address() as AddressInfo).port));
  });

async function runSimCli(): Promise<number> {
  console.log("Lifeline keeper, sim mode. No wallet, no keys, no funds: only the quotes are real, and they're dry.\n");
  const store = new Store(":memory:");
  const api = createApi({
    store,
    now,
    botUsername: null,
    attestation: () => NOT_AVAILABLE_ATTESTATION,
    corsOrigin: "*",
  });
  const port = await listen(api, 0);
  console.log(`API: http://127.0.0.1:${port}/api/stats\n`);

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
    onRecord: (record) => console.log(`  ${describeRecord(record)}`),
  });

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
  const store = new Store(config.dbPath);
  const log = (line: string) => console.log(`${now().toISOString()} ${line}`);
  const telegram =
    config.botToken === null
      ? null
      : createLifelineBot({ token: config.botToken, store, dashboardUrl: config.dashboardUrl, network: config.network, now, log });
  const keeper = new Keeper({
    store,
    vault: createNearVault(connectNear(config)),
    intents: createOneClick({
      apiUrl: config.oneClickUrl,
      nearSenderAccount: config.vaultId,
      ...(config.oneClickJwt ? { jwt: config.oneClickJwt } : {}),
    }),
    readHealth: (address) => getHealth(address),
    users: () => config.users,
    now,
    sleep,
    newId: randomUUID,
    dryQuotes: false,
    log,
    onRecord: (record) => {
      log(`${record.user}: ${describeRecord(record)}`);
      void telegram?.notify(record);
    },
  });
  const api = createApi({
    store,
    now,
    botUsername: config.botUsername,
    attestation: () => NOT_AVAILABLE_ATTESTATION,
    corsOrigin: config.corsOrigin,
  });

  const shutdown = () => {
    keeper.stop();
    void telegram?.stop();
    api.close();
    store.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  const port = await listen(api, config.port);
  console.log(`Lifeline keeper, live on ${config.network}, watching ${config.users.join(", ")}. API on port ${port}.`);
  telegram?.start();
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
