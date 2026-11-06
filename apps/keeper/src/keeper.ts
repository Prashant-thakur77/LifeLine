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
import { QuoteRefusedError, VaultRejectedError, type Intents, type ReadHealth, type SwapStatus, type Vault } from "./ports";
import { sizeRescue, type RescueSize } from "./sizing";
import type { Store } from "./store";

const SEC = 1000;
const MIN = 60 * SEC;
const HYPERLIQUID_UNITS = 10 ** ASSETS.HYPERLIQUID_USDC.decimals;

const REPEAT_RECORD_MS = WARN_RECORD_INTERVAL_SEC * SEC;
const QUOTE_RETRY_MS = 30 * SEC;
const STATUS_POLL_MS = 2 * SEC;
const CREDIT_POLL_MS = SEC;
const SENT_TIMEOUT_MS = 30 * MIN; // how long a rescue known to be sent keeps the user locked
const UNSURE_GRACE_MS = 30 * SEC; // after a crash or an unclear send, before asking the chain
const CREDIT_TIMEOUT_MS = MIN;
const REFUSED_RETRY_MS = 5 * MIN; // a refusal the engine didn't predict won't clear itself in 5 s

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

/** RPC errors can quote their URL, and a URL can carry an API key. */
const redact = (text: string) => text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");
const messageOf = (error: unknown) => redact(error instanceof Error ? error.message : String(error));
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
  private readonly firstBelowAt = new Map<string, number>();
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
      // No latency for these: the time the keeper was down isn't rescue time.
      this.runExclusive(record.user, () => this.settleUnsure(record.user, record.request as RescueRequest, fields, null));
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
      let policy: Policy | null;
      try {
        policy = await this.deps.vault.getPolicy(user);
      } catch (error) {
        this.deps.log(`${user}: vault read failed: ${messageOf(error)}`);
        this.markUnknown(user);
        return;
      }
      if (policy === null) return;

      const result = await this.read(policy.hlAddress);
      this.saveHealth(user, healthResponse(result, policy));
      if (result.status !== "ok") {
        this.deps.log(`${user}: health unknown (${result.reason})`);
        return;
      }

      const { snapshot } = result;
      if (snapshot.health < policy.warn) this.warn(user, snapshot);
      if (snapshot.health < policy.trigger) {
        if (!this.firstBelowAt.has(user)) this.firstBelowAt.set(user, this.deps.now().getTime());
        if (!this.active.has(user)) {
          const known = policy;
          this.runExclusive(user, () => this.attemptRescue(known, snapshot));
        }
      } else {
        this.firstBelowAt.delete(user);
      }
    } catch (error) {
      this.deps.log(`${user}: tick failed: ${messageOf(error)}`);
    } finally {
      this.reading.delete(user);
    }
  }

  /** A failed save mustn't stop a rescue: an out-of-date API beats an unprotected user. */
  private saveHealth(user: string, response: HealthResponse): void {
    try {
      this.deps.store.saveHealth(user, response);
    } catch (error) {
      this.deps.log(`${user}: couldn't save health: ${messageOf(error)}`);
    }
  }

  /** The API must not keep saying "ok" from an old reading when nothing can be read now. */
  private markUnknown(user: string): void {
    const last = this.deps.store.health(user);
    if (last !== null) this.saveHealth(user, { status: "unknown", snapshot: null, policy: last.policy });
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
    const detectedAt = this.firstBelowAt.get(user) ?? now().getTime();
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
        // Nothing was trying to get through, so the rescue clock shouldn't be running.
        this.firstBelowAt.delete(user);
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
      if (depositAddress === null) throw new QuoteRefusedError("the quote has no deposit address");

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
        // An account that just closed has infinite health, which JSON can't carry.
        snapshot: Number.isFinite(snapshot.health) ? snapshot : detected,
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
      this.deps.log(`${user}: rescue couldn't start: ${messageOf(error)}`);
      this.recordEarlyFailure(
        user,
        healthBefore,
        // The ledger is public, so only 1Click's own reason goes there, never a raw error.
        error instanceof QuoteRefusedError
          ? `1Click couldn't give a usable quote: ${messageOf(error)}`
          : "The keeper couldn't read what it needs for this rescue, so it didn't start. It will try again.",
      );
      return;
    }

    this.quoteRetryAt.delete(user);
    await this.send(user, request, decision, healthBefore, detectedAt);
    this.firstBelowAt.delete(user);
  }

  private async send(
    user: string,
    request: RescueRequest,
    decision: PolicyDecision,
    healthBefore: number,
    detectedAt: number,
  ): Promise<void> {
    const { vault, intents, log, now } = this.deps;
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
        // near-api-js re-signs after a nonce error, so a retry can be refused after the first landed.
        if ((await this.onChain(user, request.quoteId)) === "yes") {
          await this.settleSent(user, request, fields, detectedAt);
          return;
        }
        this.quoteRetryAt.set(user, now().getTime() + REFUSED_RETRY_MS);
        this.write(user, { ...fields, explanation: `The vault refused this rescue: ${messageOf(error)}` });
        return;
      }
      // A timeout can hide a transaction that went through.
      log(`${user}: unclear whether rescue ${request.id} was sent: ${messageOf(error)}`);
      await this.settleUnsure(user, request, fields, detectedAt);
      return;
    }

    intents
      .submitDeposit({ txHash, depositAddress: request.depositAddress })
      .catch((error) => log(`${user}: deposit hint failed: ${messageOf(error)}`));
    await this.settleSent(user, request, { ...fields, nearTx: txHash }, detectedAt);
  }

  /** Does the vault's own history show this rescue? "unknown" must never be read as "no". */
  private async onChain(user: string, quoteId: string): Promise<"yes" | "no" | "unknown"> {
    try {
      const rescues = await this.deps.vault.getRescues(user);
      if (rescues.some((rescue) => rescue.quoteId === quoteId)) return "yes";
      return rescues.some((rescue) => rescue.quoteId === undefined) ? "unknown" : "no";
    } catch (error) {
      this.deps.log(`${user}: couldn't check the vault's history: ${messageOf(error)}`);
      return "unknown";
    }
  }

  private async settleSent(user: string, request: RescueRequest, fields: RecordFields, detectedAt: number | null): Promise<void> {
    const outcome = await this.pollStatus(request.depositAddress, SENT_TIMEOUT_MS, null);
    await this.writeOutcome(user, request, fields, detectedAt, outcome);
  }

  /**
   * We don't know if this rescue went out. Writing FAILED frees the user for another
   * rescue, so it needs proof: only the chain saying no. Otherwise the lock stays on,
   * because a false FAILED can send the money twice.
   */
  private async settleUnsure(user: string, request: RescueRequest, fields: RecordFields, detectedAt: number | null): Promise<void> {
    const first = await this.pollStatus(request.depositAddress, UNSURE_GRACE_MS, null);
    if (first.final) {
      await this.writeOutcome(user, request, fields, detectedAt, first);
      return;
    }
    if ((await this.onChain(user, request.quoteId)) === "no") {
      this.write(user, {
        ...fields,
        kind: "RESCUE_FAILED",
        ...(first.status === null ? {} : { oneClickStatus: first.status }),
        explanation: "This rescue never reached the vault, so no money moved.",
      });
      return;
    }
    const outcome = await this.pollStatus(request.depositAddress, SENT_TIMEOUT_MS, first.status);
    await this.writeOutcome(user, request, fields, detectedAt, outcome);
  }

  /** Writes what happened. `fields` is whatever was already known. */
  private async writeOutcome(
    user: string,
    request: RescueRequest,
    fields: RecordFields,
    detectedAt: number | null,
    outcome: { status: SwapStatus | null; final: boolean },
  ): Promise<void> {
    const { now } = this.deps;
    const { status, final } = outcome;
    const elapsed = () => (detectedAt === null ? {} : { latencyMs: now().getTime() - detectedAt });
    const withHealth = (health: number | undefined) => {
      const after = finiteOrUndefined(health);
      return after === undefined ? {} : { healthAfter: after };
    };

    if (status === "SUCCESS") {
      const { credited, health } = await this.waitForCredit(request);
      this.write(user, {
        ...fields,
        kind: "RESCUE_DONE",
        oneClickStatus: status,
        ...withHealth(health),
        // Unconfirmed money gets no latency, which also keeps it out of the stats.
        ...(credited
          ? elapsed()
          : { explanation: "1Click reports it delivered, but the money didn't show on Hyperliquid within a minute. Prices may have moved at the same time." }),
      });
      return;
    }

    const reread = await this.read(request.recipient);
    const minutes = Math.round(SENT_TIMEOUT_MS / MIN);
    let explanation = `1Click reported ${status}, so the money didn't reach Hyperliquid.`;
    if (!final) {
      explanation =
        status === null
          ? `1Click's status couldn't be read for ${minutes} minutes, so the outcome is unknown. The money may still arrive.`
          : `1Click still not finished after ${minutes} minutes; last status ${status}. The money may still arrive.`;
    }
    this.write(user, {
      ...fields,
      kind: "RESCUE_FAILED",
      ...(status === null ? {} : { oneClickStatus: status }),
      ...withHealth(reread.status === "ok" ? reread.snapshot.health : undefined),
      ...elapsed(),
      explanation,
    });
  }

  private async pollStatus(
    depositAddress: string,
    timeoutMs: number,
    lastSeen: SwapStatus | null,
  ): Promise<{ status: SwapStatus | null; final: boolean }> {
    const { intents, now, sleep, log } = this.deps;
    const deadline = now().getTime() + timeoutMs;
    let status = lastSeen;
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
  private async waitForCredit(request: RescueRequest): Promise<{ credited: boolean; health: number | undefined }> {
    const { now, sleep } = this.deps;
    const expected = request.snapshot.accountValue + request.usdNeeded / 2;
    const deadline = now().getTime() + CREDIT_TIMEOUT_MS;
    let health: number | undefined;
    for (;;) {
      const result = await this.read(request.recipient);
      if (result.status === "ok") {
        health = result.snapshot.health;
        if (result.snapshot.accountValue >= expected) return { credited: true, health };
      }
      if (now().getTime() >= deadline) return { credited: false, health };
      await sleep(CREDIT_POLL_MS);
    }
  }
}
