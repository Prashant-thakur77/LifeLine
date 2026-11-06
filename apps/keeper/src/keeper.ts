import { evaluate, spentInLast24h, type PolicyRequest } from "@lifeline/policy";
import {
  ASSETS,
  KEEPER_POLL_INTERVAL_SEC,
  WARN_RECORD_INTERVAL_SEC,
  type AuditRecord,
  type HealthResponse,
  type HealthSnapshot,
  type Policy,
  type PolicyDecision,
  type RescueRequest,
} from "@lifeline/shared";
import type { HealthResult } from "@lifeline/hyperliquid";
import { VaultRejectedError, type Intents, type ReadHealth, type SwapStatus, type Vault } from "./ports";
import { sizeRescue, type RescueSize } from "./sizing";
import type { Store } from "./store";

const SEC = 1000;
const MIN = 60 * SEC;
const HYPERLIQUID_UNITS = 10 ** ASSETS.HYPERLIQUID_USDC.decimals;

const REPEAT_RECORD_MS = WARN_RECORD_INTERVAL_SEC * SEC;
const QUOTE_RETRY_MS = 30 * SEC;
const STATUS_POLL_MS = 2 * SEC;
const CREDIT_POLL_MS = SEC;
const RESCUE_TIMEOUT_MS = 10 * MIN;
const UNSURE_TIMEOUT_MS = 2 * MIN; // after a crash or an unclear send: a real deposit shows up fast
const CREDIT_TIMEOUT_MS = MIN;

const FINAL_STATUSES: ReadonlySet<SwapStatus> = new Set(["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"]);

export type KeeperDeps = {
  store: Store;
  vault: Vault;
  intents: Intents;
  readHealth: ReadHealth;
  users: () => string[] | Promise<string[]>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  newId: () => string;
  /** Sim mode: real quotes stay dry, so nothing can ever be deposited. */
  dryQuotes: boolean;
  log: (line: string) => void;
  /** Called after each record is saved. The Telegram bot listens here. */
  onRecord?: (record: AuditRecord) => void;
};

type RecordFields = Omit<AuditRecord, "id" | "at" | "user">;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const finiteOrUndefined = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? value : undefined;

function healthResponse(result: HealthResult, policy: Policy): HealthResponse {
  if (result.status !== "ok") return { status: "unknown", snapshot: null, policy };
  const { snapshot } = result;
  return {
    status: "ok",
    snapshot: { ...snapshot, health: Number.isFinite(snapshot.health) ? snapshot.health : null },
    policy,
  };
}

/**
 * The watch loop. Each tick reads every protected user's health, warns, and
 * starts a rescue when one is needed. Rescues run alongside the ticks, so a
 * slow rescue never stops anyone else from being watched.
 */
export class Keeper {
  private readonly active = new Set<string>();
  private readonly reading = new Set<string>();
  private readonly quoteRetryAt = new Map<string, number>();
  private readonly tasks = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(private readonly deps: KeeperDeps) {}

  /** Ticks every 5 s until stop(), without waiting for a slow tick to finish. */
  async run(intervalMs = KEEPER_POLL_INTERVAL_SEC * SEC): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      this.track(this.tick());
      await this.deps.sleep(intervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async tick(): Promise<void> {
    try {
      const users = await this.deps.users();
      await Promise.all(users.map((user) => this.tickUser(user)));
    } catch (error) {
      this.deps.log(`tick failed: ${messageOf(error)}`);
    }
  }

  /** Resolves once every running tick and rescue has finished. */
  async settled(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all(this.tasks);
  }

  /** Call once at startup: picks up rescues a crash left without an outcome. */
  recover(): void {
    for (const record of this.deps.store.unfinishedRescues()) {
      if (record.request === undefined) continue;
      const fields: RecordFields = {
        kind: "RESCUE_FAILED",
        request: record.request,
        ...(record.decision === undefined ? {} : { decision: record.decision }),
        ...(record.healthBefore === undefined ? {} : { healthBefore: record.healthBefore }),
      };
      this.deps.log(`resuming rescue ${record.request.id} for ${record.user}`);
      this.runExclusive(record.user, () =>
        this.follow(record.user, record.request as RescueRequest, fields, Date.parse(record.at), UNSURE_TIMEOUT_MS),
      );
    }
  }

  private track<T>(task: Promise<T>): void {
    const tracked: Promise<unknown> = task.finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
  }

  /** Marks the user busy before anything async happens, so a rescue can't start twice. */
  private runExclusive(user: string, work: () => Promise<void>): void {
    this.active.add(user);
    this.track(
      work()
        .catch((error) => this.deps.log(`rescue for ${user} stopped: ${messageOf(error)}`))
        .finally(() => this.active.delete(user)),
    );
  }

  private async tickUser(user: string): Promise<void> {
    if (this.reading.has(user)) return;
    this.reading.add(user);
    try {
      const policy = await this.deps.vault.getPolicy(user);
      if (policy === null) return;

      const result = await this.read(policy.hlAddress);
      this.deps.store.saveHealth(user, healthResponse(result, policy));
      if (result.status !== "ok") {
        this.deps.log(`${user}: health unknown (${result.reason})`);
        return;
      }

      const { snapshot } = result;
      if (snapshot.health < policy.warn) this.warn(user, snapshot);
      if (snapshot.health < policy.trigger && !this.active.has(user)) {
        this.runExclusive(user, () => this.attemptRescue(policy, snapshot));
      }
    } catch (error) {
      this.deps.log(`${user}: tick failed: ${messageOf(error)}`);
    } finally {
      this.reading.delete(user);
    }
  }

  private async read(hlAddress: string): Promise<HealthResult> {
    try {
      return await this.deps.readHealth(hlAddress);
    } catch (error) {
      return { status: "unknown", reason: "API_ERROR", detail: messageOf(error) };
    }
  }

  private write(user: string, fields: RecordFields): void {
    const { store, newId, now, onRecord, log } = this.deps;
    const record: AuditRecord = { id: newId(), user, at: now().toISOString(), ...fields };
    store.append(record);
    log(`${user}: ${record.kind}${record.decision?.reasons.length ? ` ${record.decision.reasons.join(",")}` : ""}`);
    try {
      onRecord?.(record);
    } catch (error) {
      log(`record listener failed: ${messageOf(error)}`);
    }
  }

  private isRecent(record: AuditRecord | null): record is AuditRecord {
    return record !== null && this.deps.now().getTime() - Date.parse(record.at) < REPEAT_RECORD_MS;
  }

  private warn(user: string, snapshot: HealthSnapshot): void {
    if (this.isRecent(this.deps.store.latest(user, "WARN"))) return;
    this.write(user, { kind: "WARN", healthBefore: snapshot.health });
  }

  private recordBlock(user: string, healthBefore: number, decision: PolicyDecision, request?: PolicyRequest): void {
    const last = this.deps.store.latest(user, "RESCUE_BLOCKED");
    if (this.isRecent(last) && last.decision?.reasons.join() === decision.reasons.join()) return;
    this.write(user, { kind: "RESCUE_BLOCKED", decision, healthBefore, ...(request ? { request } : {}) });
  }

  /** A rescue that failed before any money moved. It gets retried, so it isn't repeated in the log. */
  private recordEarlyFailure(user: string, healthBefore: number, explanation: string): void {
    const last = this.deps.store.latest(user, "RESCUE_FAILED");
    if (this.isRecent(last) && last.request === undefined && last.explanation === explanation) return;
    this.write(user, { kind: "RESCUE_FAILED", healthBefore, explanation });
  }

  /**
   * A request where every quote fact is already correct. evaluate() can then only
   * object to what no quote could fix: pause, cooldown, caps or an empty reserve.
   * That check costs no network call, so it's safe to repeat every 5 s.
   */
  private draftRequest(policy: Policy, snapshot: HealthSnapshot, size: RescueSize, id: string): PolicyRequest {
    return {
      id,
      user: policy.user,
      token: ASSETS.NEAR_USDC.contractId,
      amount: size.amount,
      usdNeeded: size.usdNeeded,
      quoteId: "draft",
      depositAddress: "draft",
      recipient: policy.hlAddress,
      quoteAt: this.deps.now().toISOString(),
      snapshot,
      destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId,
      minAmountOutUsd: size.usdNeeded,
      refundTo: policy.user,
    };
  }

  private async attemptRescue(policy: Policy, detected: HealthSnapshot): Promise<void> {
    const { vault, intents, now, newId, dryQuotes } = this.deps;
    const { user, hlAddress } = policy;
    const token = ASSETS.NEAR_USDC.contractId;
    const detectedAt = now().getTime();
    const healthBefore = detected.health;

    let request: PolicyRequest;
    let decision: PolicyDecision;
    try {
      const [rescues, reserve] = await Promise.all([vault.getRescues(user), vault.getReserve(user, token)]);
      const history = { rescues, reserve };
      const spentToday = spentInLast24h(rescues, now());
      const sized = (withdrawFeeUsd: number) =>
        sizeRescue({ snapshot: detected, policy, withdrawFeeUsd, reserve, spentToday });

      const draft = sized(0);
      const precheck = evaluate(this.draftRequest(policy, detected, draft, "draft"), policy, history, detected, now());
      if (precheck.verdict === "block") {
        this.recordBlock(user, healthBefore, precheck);
        return;
      }
      if (now().getTime() < (this.quoteRetryAt.get(user) ?? 0)) return;

      const quoteParams = { recipient: hlAddress, refundTo: user };
      const probe = await intents.getQuote({ ...quoteParams, amount: draft.amount, dry: true });
      const size = sized(Number(probe.withdrawFee) / HYPERLIQUID_UNITS);
      const quote = await intents.getQuote({ ...quoteParams, amount: size.amount, dry: dryQuotes });

      const id = newId();
      const depositAddress = quote.depositAddress ?? (dryQuotes ? `sim-${id}` : null);
      if (depositAddress === null) throw new Error("1Click returned a quote with no deposit address");

      const fresh = await this.read(hlAddress);
      const snapshot = fresh.status === "ok" ? fresh.snapshot : detected;
      request = {
        id,
        user,
        token,
        amount: quote.amountIn,
        usdNeeded: size.usdNeeded,
        quoteId: quote.quoteId,
        depositAddress,
        recipient: quote.recipient,
        quoteAt: quote.quotedAt,
        snapshot,
        destinationAsset: quote.destinationAsset,
        minAmountOutUsd: Number(quote.minAmountOut) / HYPERLIQUID_UNITS,
        refundTo: quote.refundTo,
      };

      decision = evaluate(request, policy, history, snapshot, now());
      if (decision.verdict === "block") {
        this.quoteRetryAt.set(user, now().getTime() + QUOTE_RETRY_MS);
        this.recordBlock(user, healthBefore, decision, request);
        return;
      }
    } catch (error) {
      this.quoteRetryAt.set(user, now().getTime() + QUOTE_RETRY_MS);
      this.recordEarlyFailure(user, healthBefore, `The rescue couldn't start: ${messageOf(error)}`);
      return;
    }

    this.quoteRetryAt.delete(user);
    await this.send(user, request, decision, healthBefore, detectedAt);
  }

  private async send(
    user: string,
    request: RescueRequest,
    decision: PolicyDecision,
    healthBefore: number,
    detectedAt: number,
  ): Promise<void> {
    const { vault, intents, log } = this.deps;
    const fields: RecordFields = { kind: "RESCUE_FAILED", request, decision, healthBefore };
    // Written first: if we crash mid-send, the restart knows a rescue may be out there.
    this.write(user, { ...fields, kind: "RESCUE_ALLOWED" });

    let txHash: string;
    try {
      ({ txHash } = await vault.rescue({
        user,
        token: request.token,
        amount: request.amount,
        depositAddress: request.depositAddress,
        recipient: request.recipient,
        quoteId: request.quoteId,
      }));
    } catch (error) {
      if (error instanceof VaultRejectedError) {
        this.write(user, { ...fields, explanation: `The vault refused this rescue: ${error.message}` });
        return;
      }
      // A timeout can hide a transaction that went through. Let 1Click settle it.
      log(`${user}: unclear whether rescue ${request.id} was sent: ${messageOf(error)}`);
      await this.follow(user, request, fields, detectedAt, UNSURE_TIMEOUT_MS);
      return;
    }

    intents
      .submitDeposit({ txHash, depositAddress: request.depositAddress })
      .catch((error) => log(`${user}: deposit hint failed: ${messageOf(error)}`));
    await this.follow(user, request, { ...fields, nearTx: txHash }, detectedAt, RESCUE_TIMEOUT_MS);
  }

  /** Waits for the outcome and writes it. `fields` is whatever is already known. */
  private async follow(
    user: string,
    request: RescueRequest,
    fields: RecordFields,
    detectedAt: number,
    timeoutMs: number,
  ): Promise<void> {
    const { now } = this.deps;
    const { status, final } = await this.pollStatus(request.depositAddress, timeoutMs);

    if (status === "SUCCESS") {
      const healthAfter = await this.waitForCredit(request);
      const after = finiteOrUndefined(healthAfter);
      this.write(user, {
        ...fields,
        kind: "RESCUE_DONE",
        oneClickStatus: status,
        ...(after === undefined ? {} : { healthAfter: after }),
        latencyMs: now().getTime() - detectedAt,
      });
      return;
    }

    const reread = await this.read(request.recipient);
    const after = reread.status === "ok" ? finiteOrUndefined(reread.snapshot.health) : undefined;
    this.write(user, {
      ...fields,
      kind: "RESCUE_FAILED",
      oneClickStatus: status,
      ...(after === undefined ? {} : { healthAfter: after }),
      latencyMs: now().getTime() - detectedAt,
      explanation: final
        ? `1Click reported ${status}, so the money didn't reach Hyperliquid.`
        : `1Click still not finished after ${Math.round(timeoutMs / MIN)} minutes; last status ${status}.`,
    });
  }

  private async pollStatus(depositAddress: string, timeoutMs: number): Promise<{ status: SwapStatus; final: boolean }> {
    const { intents, now, sleep, log } = this.deps;
    const deadline = now().getTime() + timeoutMs;
    let status: SwapStatus = "PENDING_DEPOSIT";
    for (;;) {
      try {
        status = await intents.getStatus(depositAddress);
        if (FINAL_STATUSES.has(status)) return { status, final: true };
      } catch (error) {
        log(`status read failed: ${messageOf(error)}`);
      }
      if (now().getTime() >= deadline) return { status, final: false };
      await sleep(STATUS_POLL_MS);
    }
  }

  /**
   * Latency runs until the money shows on Hyperliquid, not until 1Click says done.
   * Half the expected amount counts as arrived, because prices move at the same time.
   */
  private async waitForCredit(request: RescueRequest): Promise<number | undefined> {
    const { now, sleep } = this.deps;
    const credited = request.snapshot.accountValue + request.usdNeeded / 2;
    const deadline = now().getTime() + CREDIT_TIMEOUT_MS;
    let health: number | undefined;
    for (;;) {
      const result = await this.read(request.recipient);
      if (result.status === "ok") {
        health = result.snapshot.health;
        if (result.snapshot.accountValue >= credited) return health;
      }
      if (now().getTime() >= deadline) return health;
      await sleep(CREDIT_POLL_MS);
    }
  }
}
