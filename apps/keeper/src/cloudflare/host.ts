import { createLifelineBot, type BotOptions, type LifelineBot } from "@lifeline/bot";
import { getHealth, getMidPrice } from "@lifeline/hyperliquid";
import { KEEPER_POLL_INTERVAL_SEC, type AttestationResponse, type AuditRecord } from "@lifeline/shared";
import { handleApi, jsonResponse } from "../api";
import { AttestationMonitor, checkAttestation, type IntelDcap } from "../attestation";
import { readLiveConfig, readServiceSettings, type LiveConfig, type ServiceSettings } from "../config";
import { createExplainer } from "../explain";
import { describeRecord } from "../format";
import { Keeper } from "../keeper";
import { connectNear, createNearVault } from "../near";
import { createOneClick } from "../oneclick";
import { createRecordPipeline } from "../pipeline";
import type { Intents, ReadHealth, Vault } from "../ports";
import { createSimLoop } from "../sim";
import { durableSql, type DurableSqlStorage } from "../sql-durable";
import { Store } from "../store";

const TICK_MS = KEEPER_POLL_INTERVAL_SEC * 1000;
const SIM_REST_MS = 15 * 60_000; // between demo drops: about four rescues an hour
const WEBHOOK_PATH = "/telegram/webhook";

/** A Durable Object's storage: its SQLite and its one alarm. */
export type HostStorage = DurableSqlStorage & {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
};

/** Stand-ins for the network, so tests never touch it. Each one defaults to the real thing. */
export type HostSeams = {
  quotes?: Pick<Intents, "getQuote">;
  startPrice?: () => Promise<number>;
  vault?: Vault;
  intents?: Intents;
  readHealth?: ReadHealth;
  checkAttestation?: () => Promise<AttestationResponse>;
  botInfo?: BotOptions["botInfo"];
  wrapBot?: (bot: LifelineBot) => void;
};

export type HostDeps = {
  storage: HostStorage;
  env: Record<string, string | undefined>;
  intel: IntelDcap;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  seams?: HostSeams;
};

export type HostConfig = ServiceSettings & {
  mode: "sim" | "live";
  network: "testnet" | "mainnet";
  publicUrl: string | null;
  live: LiveConfig | null;
};

/**
 * KEEPER_MODE picks sim or live. Live reads exactly what `--live` reads, with the same
 * checks: mainnet still needs KEEPER_ALLOW_MAINNET=yes. Sim needs nothing else.
 */
export function readHostConfig(env: Record<string, string | undefined>): HostConfig {
  const mode = env.KEEPER_MODE?.trim();
  const publicUrl = env.PUBLIC_URL?.trim().replace(/\/+$/, "") || null;
  if (publicUrl !== null && !publicUrl.startsWith("https://")) throw new Error("PUBLIC_URL must start with https://");
  if (mode === "live") {
    const live = readLiveConfig(env);
    return { ...live, mode, network: live.network, publicUrl, live };
  }
  // Sim quotes are real mainnet quotes, so its links and wording are mainnet's.
  if (mode === "sim") return { ...readServiceSettings(env), mode, network: "mainnet", publicUrl, live: null };
  throw new Error("KEEPER_MODE must be sim or live");
}

type Engine = { tick(): Promise<void>; settled(): Promise<void>; recover?(): void };

type Running = {
  config: HostConfig;
  store: Store;
  bot: LifelineBot | null;
  engine: Engine;
  attestation: AttestationMonitor;
  pipeline: ReturnType<typeof createRecordPipeline>;
  watching: number;
};

export type KeeperHost = {
  /** Call once, when the object wakes. */
  start(): Promise<void>;
  /** One keeper tick. Arms the next alarm first, so nothing can stop the loop. */
  alarm(): Promise<void>;
  /** Arms an alarm if none is set: a cron calls this in case the loop ever stops. */
  ensureRunning(): Promise<void>;
  fetch(request: Request): Promise<Response>;
  /** Resolves when every rescue, message and check in flight is done. For tests. */
  settled(): Promise<void>;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The keeper as it runs inside a Cloudflare Durable Object: the same Keeper, store,
 * API, bot, explanations and attestation as `--live`, driven by the object's alarm
 * every 5 s instead of a loop, and keeping its SQLite in the object's own storage.
 * Nothing here is specific to Cloudflare beyond that storage, so it's tested in Node.
 */
export function createKeeperHost(deps: HostDeps): KeeperHost {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? ((line: string) => console.log(line));
  const seams = deps.seams ?? {};
  const background = new Set<Promise<unknown>>();
  let state: Running | { broken: string } | null = null;

  const track = (work: Promise<unknown>) => {
    const tracked: Promise<unknown> = work.catch((error) => log(`background work failed: ${messageOf(error)}`)).finally(() => background.delete(tracked));
    background.add(tracked);
  };

  const build = (): Running => {
    const config = readHostConfig(deps.env);
    const store = new Store(durableSql(deps.storage));

    let bot: LifelineBot | null = null;
    if (config.botToken !== null) {
      bot = createLifelineBot({
        token: config.botToken,
        store,
        dashboardUrl: config.dashboardUrl,
        network: config.network,
        now,
        log,
        sleep,
        ...(seams.botInfo ? { botInfo: seams.botInfo } : {}),
      });
      seams.wrapBot?.(bot);
    }

    const explainer = createExplainer({ baseUrl: config.nearAiUrl, apiKey: config.nearAiKey, model: config.nearAiModel, log });
    const pipeline = createRecordPipeline({
      store,
      explain: (record) => explainer.explain(record),
      notify: async (record) => bot?.notify(record),
      log,
    });
    const onRecord = (record: AuditRecord) => {
      log(`${record.user}: ${describeRecord(record)}`);
      pipeline.handle(record);
    };
    const attestation = new AttestationMonitor(
      seams.checkAttestation ??
        (() => checkAttestation({ baseUrl: config.nearAiUrl, model: config.nearAiModel, apiKey: config.nearAiKey, now, intel: deps.intel })),
      { sleep },
    );

    let engine: Engine;
    let watching: number;
    if (config.live !== null) {
      const live = config.live;
      const keeper = new Keeper({
        store,
        vault: seams.vault ?? createNearVault(connectNear(live)),
        intents:
          seams.intents ??
          createOneClick({ apiUrl: live.oneClickUrl, nearSenderAccount: live.vaultId, ...(live.oneClickJwt ? { jwt: live.oneClickJwt } : {}) }),
        readHealth: seams.readHealth ?? ((address) => getHealth(address)),
        users: () => live.users,
        now,
        sleep,
        newId: () => crypto.randomUUID(),
        dryQuotes: false,
        log,
        onRecord,
      });
      engine = { tick: () => keeper.tick(), settled: () => keeper.settled(), recover: () => keeper.recover() };
      watching = live.users.length;
    } else {
      // No recover() here: a sim drop that a restart cut short had no money in it.
      engine = createSimLoop({
        store,
        quotes: seams.quotes ?? createOneClick({ apiUrl: config.oneClickUrl, nearSenderAccount: "vault.sim.near" }),
        now,
        sleep,
        log,
        restMs: SIM_REST_MS,
        startPrice: seams.startPrice ?? (() => getMidPrice("ETH")),
        onRecord,
      });
      watching = 1;
    }
    return { config, store, bot, engine, attestation, pipeline, watching };
  };

  const armIfIdle = async () => {
    if (state === null || "broken" in state) return;
    if ((await deps.storage.getAlarm()) === null) await deps.storage.setAlarm(now().getTime() + TICK_MS);
  };

  const refreshAttestation = (running: Running) => track(running.attestation.refreshIfDue(now().getTime()));

  const route = async (running: Running, request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === WEBHOOK_PATH && running.bot !== null) return running.bot.handleWebhook(request);
    if (pathname === "/") {
      return jsonResponse(
        200,
        {
          service: "lifeline-keeper",
          mode: running.config.mode,
          network: running.config.network,
          watching: running.watching,
          api: ["/api/health/:user", "/api/audit?user=", "/api/ledger", "/api/stats", "/api/attestation", "POST /api/telegram/link"],
        },
        running.config.corsOrigin,
      );
    }
    return handleApi(request, {
      store: running.store,
      now,
      botUsername: running.config.botUsername,
      attestation: () => running.attestation.latest(),
      corsOrigin: running.config.corsOrigin,
    });
  };

  return {
    async start() {
      try {
        state = build();
      } catch (error) {
        // Settings errors name settings, never values: see readLiveConfig.
        state = { broken: messageOf(error) };
        log(`keeper not started: ${state.broken}`);
        return;
      }
      const running = state;
      running.engine.recover?.();
      running.pipeline.backfill();
      refreshAttestation(running);
      if (running.bot !== null && running.config.publicUrl !== null) {
        track(running.bot.registerWebhook(`${running.config.publicUrl}${WEBHOOK_PATH}`));
      }
      await armIfIdle();
      log(`keeper started: ${running.config.mode} on ${running.config.network}, watching ${running.watching}`);
    },

    async alarm() {
      if (state === null || "broken" in state) return;
      const running = state;
      await deps.storage.setAlarm(now().getTime() + TICK_MS);
      try {
        await running.engine.tick();
      } catch (error) {
        log(`tick failed: ${messageOf(error)}`);
      }
      refreshAttestation(running);
    },

    ensureRunning: armIfIdle,

    async fetch(request) {
      if (state === null || "broken" in state) {
        const reason = state === null ? "starting" : state.broken;
        return jsonResponse(503, { error: `the keeper isn't running: ${reason}` }, "*");
      }
      try {
        return await route(state, request);
      } catch (error) {
        log(`request failed: ${messageOf(error)}`);
        return jsonResponse(500, { error: "internal error" }, state.config.corsOrigin);
      }
    },

    async settled() {
      if (state === null || "broken" in state) return;
      await state.engine.settled();
      while (background.size > 0) await Promise.all(background);
      await state.pipeline.settled();
    },
  };
}
