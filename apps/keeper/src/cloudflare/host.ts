import { createLifelineBot, type BotOptions, type LifelineBot } from "@lifeline/bot";
import { getHealth, getMidPrice } from "@lifeline/hyperliquid";
import { KEEPER_POLL_INTERVAL_SEC, type AttestationResponse, type AuditRecord } from "@lifeline/shared";
import { createLinkLimiter, handleApi, jsonResponse } from "../api";
import { createAttackLab, TESTNET_LAB, type AttackLab, type LabSaved } from "../attack-lab";
import { AttestationMonitor, checkAttestationWithSigners, type IntelDcap, type SavedAttestation } from "../attestation";
import { readLiveConfig, readServiceSettings, type LiveConfig, type ServiceSettings } from "../config";
import { createExplainer } from "../explain";
import { describeRecord } from "../format";
import { Keeper } from "../keeper";
import { connectNear, createNearVault, type NearClient } from "../near";
import { canRescue, createUserList } from "../users";
import { createOneClick } from "@lifeline/intents";
import { createRecordPipeline } from "../pipeline";
import type { Intents, ReadHealth, Vault } from "../ports";
import { createSimLoop } from "../sim";
import { durableSql, type DurableSqlStorage } from "../sql-durable";
import { Store } from "../store";

const TICK_MS = KEEPER_POLL_INTERVAL_SEC * 1000;
// One alarm a minute, with a tick every 5 s inside it. Each setAlarm is a row written,
// and the free plan allows 100,000 a day: an alarm every 5 s alone would use 17,280.
const ALARM_MS = 60_000;
const TICKS_PER_ALARM = ALARM_MS / TICK_MS;
const STALE_ALARM_MS = 2 * ALARM_MS; // an alarm this far overdue isn't going to fire by itself
const SIM_REST_MS = 15 * 60_000; // between demo drops: about four rescues an hour
const WEBHOOK_PATH = "/telegram/webhook";
/** Shown at / as the network in sim mode: the prices are mainnet's, but nothing runs on mainnet. */
const SIM_NETWORK_LABEL = "Simulation · live mainnet prices";
/** Shown at / in sim mode, beside SIM_NETWORK_LABEL. */
const SIM_NOTE =
  "ETH prices and 1Click quotes are real mainnet ones (quotes are dry, so nothing can be deposited); the position, the vault and settlement are pretend. It runs with no keys and no funds.";
const ATTESTATION_KEY = "attestation";
const LAB_KEY = "attack-lab";
const TESTNET_RPC_URL = "https://test.rpc.fastnear.com";

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
  /** The testnet chain the attack lab sends to. */
  labClient?: NearClient;
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

type Engine = { tick(): Promise<void>; settled(): Promise<void>; recover?(): void; nextTickInMs?(tickMs: number): number };

type Running = {
  config: HostConfig;
  store: Store;
  bot: LifelineBot | null;
  engine: Engine;
  attestation: AttestationMonitor;
  pipeline: ReturnType<typeof createRecordPipeline>;
  /** How many users the keeper is watching right now. */
  watching: () => number;
  /** The public attack lab: on the sim keeper only, when it has the lab's testnet keys. */
  lab: AttackLab | null;
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

/** Errors can quote a URL, and a URL can carry a key, so logs never get one. */
const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");

/** A settings error names settings, never their values (see readLiveConfig), so it's safe to show. */
class SettingsError extends Error {}
const COULDNT_START = "the keeper couldn't start; its logs say why";

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
  // A broken keeper that can retry failed for a passing reason, like a daily quota; bad settings need a redeploy.
  let state: Running | { broken: string; canRetry: boolean } | null = null;

  const track = (work: Promise<unknown>) => {
    const tracked: Promise<unknown> = work.catch((error) => log(`background work failed: ${messageOf(error)}`)).finally(() => background.delete(tracked));
    background.add(tracked);
  };

  const build = (): Running => {
    let config: HostConfig;
    try {
      config = readHostConfig(deps.env);
    } catch (error) {
      throw new SettingsError(messageOf(error));
    }
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

    const explainer = createExplainer({
      baseUrl: config.nearAiUrl,
      apiKey: config.nearAiKey,
      model: config.nearAiModel,
      log,
      sleep,
      // Declared below; only read once records arrive, by which time it exists.
      signers: () => attestation.signers(),
      onUnknownSigner: () => attestation.recheckSoon(now().getTime()),
    });
    const pipeline = createRecordPipeline({
      store,
      explain: (record) => explainer.explainWithProof(record),
      notify: async (record) => bot?.notify(record),
      log,
    });
    const onRecord = (record: AuditRecord) => {
      log(`${record.user}: ${describeRecord(record)}`);
      pipeline.handle(record);
    };
    const attestation = new AttestationMonitor(
      seams.checkAttestation ??
        (() => checkAttestationWithSigners({ baseUrl: config.nearAiUrl, model: config.nearAiModel, apiKey: config.nearAiKey, now, intel: deps.intel })),
      {
        sleep,
        onChecked: (saved) => {
          try {
            store.saveState(ATTESTATION_KEY, saved);
          } catch (error) {
            log(`couldn't save the attestation check: ${messageOf(error)}`);
          }
        },
      },
    );
    const saved = store.loadState<SavedAttestation>(ATTESTATION_KEY);
    if (saved !== null) attestation.restore(saved);

    let engine: Engine;
    let watching: () => number;
    if (config.live !== null) {
      const live = config.live;
      const vault = seams.vault ?? createNearVault(connectNear(live), { keeperAccountId: live.keeperAccountId });
      const userList = createUserList({
        fixed: live.users,
        load: async () => (await vault.getUsers?.()) ?? [],
        accept: canRescue(vault),
        now: () => now().getTime(),
        log,
      });
      const keeper = new Keeper({
        store,
        vault,
        intents:
          seams.intents ??
          createOneClick({ apiUrl: live.oneClickUrl, nearSenderAccount: live.vaultId, ...(live.oneClickJwt ? { jwt: live.oneClickJwt } : {}) }),
        readHealth: seams.readHealth ?? ((address) => getHealth(address)),
        users: () => userList.users(),
        now,
        sleep,
        newId: () => crypto.randomUUID(),
        dryQuotes: false,
        log,
        onRecord,
      });
      engine = { tick: () => keeper.tick(), settled: () => keeper.settled(), recover: () => keeper.recover() };
      watching = () => userList.users().length;
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
      watching = () => 1;
    }
    // The lab runs only beside the sim: the real keeper never holds the lab's testnet keys.
    const labKey = deps.env.TESTNET_LAB_KEEPER_KEY?.trim();
    const standInKey = deps.env.TESTNET_QUOTE_SIGNER_KEY?.trim();
    let lab: AttackLab | null = null;
    if (config.mode === "sim" && labKey && standInKey) {
      try {
        lab = createAttackLab({
          client:
            seams.labClient ??
            connectNear({ rpcUrl: deps.env.TESTNET_RPC_URL?.trim() || TESTNET_RPC_URL, vaultId: TESTNET_LAB.vault, keeperAccountId: TESTNET_LAB.keeper, keeperKey: labKey }),
          target: TESTNET_LAB,
          signerKey: standInKey,
          now,
          log,
          saved: store.loadState<LabSaved>(LAB_KEY),
          onSave: (saved) => {
            try {
              store.saveState(LAB_KEY, saved);
            } catch (error) {
              log(`couldn't save the lab's attacks: ${messageOf(error)}`);
            }
          },
        });
      } catch (error) {
        // A bad lab key leaves the lab off, never the demo keeper itself.
        log(`the attack lab couldn't start: ${messageOf(error)}`);
      }
    }
    return { config, store, bot, engine, attestation, pipeline, watching, lab };
  };

  const allowLink = createLinkLimiter();
  let startedAt: Date | null = null;
  let lastTickAt: Date | null = null;

  /** Arms an alarm if there's none, or if the one there is long overdue and evidently stuck. */
  const armIfIdle = async () => {
    if (state === null || "broken" in state) return;
    const at = await deps.storage.getAlarm();
    if (at === null || at < now().getTime() - STALE_ALARM_MS) await deps.storage.setAlarm(now().getTime() + TICK_MS);
  };

  const refreshAttestation = (running: Running) => track(running.attestation.refreshIfDue(now().getTime()));

  /** Not awaited: a slow or hung tick mustn't hold up the next one. The Keeper never reads a user twice at once. */
  const startTick = (running: Running) =>
    track(
      running.engine.tick().then(() => {
        lastTickAt = now();
      }),
    );

  /** Each step is caught on its own: one failing mustn't leave the keeper without an alarm. */
  const attempt = async (what: string, work: () => unknown) => {
    try {
      await work();
    } catch (error) {
      log(`${what} failed: ${messageOf(error)}`);
    }
  };

  const route = async (running: Running, request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === WEBHOOK_PATH && running.bot !== null) return running.bot.handleWebhook(request);
    if (pathname === "/") {
      const alarmAt = await deps.storage.getAlarm();
      return jsonResponse(
        200,
        {
          service: "lifeline-keeper",
          mode: running.config.mode,
          network: running.config.mode === "sim" ? SIM_NETWORK_LABEL : running.config.network,
          ...(running.config.mode === "sim" ? { simulation: SIM_NOTE } : {}),
          version: deps.env.KEEPER_VERSION?.trim() || null,
          watching: running.watching(),
          startedAt: startedAt?.toISOString() ?? null,
          lastTickAt: lastTickAt?.toISOString() ?? null,
          nextAlarmAt: alarmAt === null ? null : new Date(alarmAt).toISOString(),
          api: ["/api/health/:user", "/api/audit?user=", "/api/ledger", "/api/stats", "/api/attestation", "/api/proof/:recordId", "/api/proof/latest?user=", ...(running.lab ? ["/api/lab", "POST /api/lab/attack"] : []), "POST /api/telegram/link"],
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
      allowLink,
      lab: running.lab,
    });
  };

  const start = async (): Promise<void> => {
      try {
        state = build();
      } catch (error) {
        const settings = error instanceof SettingsError;
        state = { broken: settings ? error.message : COULDNT_START, canRetry: !settings };
        log(`keeper not started: ${messageOf(error)}`);
        return;
      }
      const running = state;
      startedAt = now();
      await attempt("picking up unfinished rescues", () => running.engine.recover?.());
      await attempt("explaining old records", () => running.pipeline.backfill());
      refreshAttestation(running);
      if (running.bot !== null && running.config.publicUrl !== null) {
        track(running.bot.registerWebhook(`${running.config.publicUrl}${WEBHOOK_PATH}`));
      }
      await attempt("arming the alarm", armIfIdle);
      log(`keeper started: ${running.config.mode} on ${running.config.network}, watching ${running.watching()}`);
  };

  return {
    start,

    async alarm() {
      if (state === null || "broken" in state) return;
      const running = state;
      // The next alarm first: Cloudflare retries a failed alarm, but only up to 6 times.
      await deps.storage.setAlarm(now().getTime() + ALARM_MS);
      for (let i = 0; i < TICKS_PER_ALARM; i += 1) {
        if (i > 0) await sleep(TICK_MS);
        startTick(running);
        refreshAttestation(running);
        // Only the sim ever asks for longer: between drops it lets the object sleep.
        const wanted = running.engine.nextTickInMs?.(TICK_MS) ?? TICK_MS;
        if (wanted > TICK_MS) {
          await deps.storage.setAlarm(now().getTime() + wanted);
          return;
        }
      }
    },

    async ensureRunning() {
      if (state !== null && "broken" in state && state.canRetry) await start();
      await armIfIdle();
    },

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
