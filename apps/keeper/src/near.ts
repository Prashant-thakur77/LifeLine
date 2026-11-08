import { POLICY_RANGES, type Policy } from "@lifeline/shared";
import { Account, actions, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";
import { InvalidTransactionError, TransactionExecutionError } from "near-api-js/rpc-errors";
import { VaultRejectedError, type RescueRecord, type Vault } from "./ports";

const RESCUE_GAS_TGAS = "100";
const RESCUES_PAGE = 100;
/** The daily cap looks back 24 h; an hour more covers clock differences. */
const HISTORY_MS = 25 * 60 * 60 * 1000;
const USERS_PAGE = 100;
/** What the keeper says when `rescue` resolves to false: the vault refunded a failed transfer. */
export const REFUNDED = "the transfer to 1Click failed, so the vault put the money back in the reserve";
const VIEW_TIMEOUT_MS = 5_000; // a stuck read would stop the watch loop for this user
const CALL_TIMEOUT_MS = 60_000; // longer than the RPC's own wait, and a timeout here means "unknown"
const UNITS = /^\d+$/;

/** The two things the vault adapter needs from NEAR. */
export type NearClient = {
  view(method: string, args: Record<string, unknown>): Promise<unknown>;
  /**
   * `failure` means the chain ran it and it failed. A throw means the outcome is unknown.
   * `value` is the JSON the call resolved to, if any.
   */
  call(method: string, args: Record<string, unknown>): Promise<{ txHash: string; failure: string | null; value?: unknown }>;
};

type Raw = Record<string, unknown>;

/** The contract's JSON isn't final until A4 lands, so accept either naming style. */
const pick = (raw: Raw, ...names: string[]) => {
  for (const name of names) if (raw[name] !== undefined) return raw[name];
  return undefined;
};

const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && value >= min && value <= max;

function parsePolicy(user: string, raw: Raw): Policy {
  const hlAddress = pick(raw, "hl_address", "hlAddress");
  const maxPerRescue = pick(raw, "max_per_rescue", "maxPerRescue");
  const maxPerDay = pick(raw, "max_per_day", "maxPerDay");
  const cooldownSec = pick(raw, "cooldown_sec", "cooldownSec");
  const { warn, trigger, target, paused } = raw;

  const readable =
    typeof hlAddress === "string" &&
    hlAddress !== "" &&
    typeof maxPerRescue === "string" &&
    UNITS.test(maxPerRescue) &&
    typeof maxPerDay === "string" &&
    UNITS.test(maxPerDay) &&
    typeof cooldownSec === "number" &&
    cooldownSec >= 0 &&
    typeof paused === "boolean" &&
    inRange(warn, POLICY_RANGES.warn.min, POLICY_RANGES.warn.max) &&
    inRange(trigger, POLICY_RANGES.trigger.min, POLICY_RANGES.trigger.max) &&
    inRange(target, 1, POLICY_RANGES.target.max);
  // A scale mismatch, like 150 for 1.5, must stop rescues rather than change them.
  if (!readable) throw new Error(`the vault's policy for ${user} is unreadable or out of range`);

  return { user, hlAddress, warn, trigger, target, maxPerRescue, maxPerDay, cooldownSec, paused };
}

function reserveOf(raw: unknown, token: string): string {
  if (raw === null || raw === undefined) return "0";
  const entries = Array.isArray(raw) ? (raw as [string, unknown][]) : Object.entries(raw as Raw);
  const amount = entries.find(([id]) => id === token)?.[1];
  if (amount === undefined) return "0";
  if (typeof amount !== "string" || !UNITS.test(amount)) throw new Error(`unreadable reserve for ${token}`);
  return amount;
}

/** NEAR block times are nanoseconds. Anything unreadable throws, so it can't dodge a cooldown. */
function chainTimeToIso(value: unknown): string {
  let ms: number | null = null;
  if (typeof value === "string" && UNITS.test(value)) ms = Number(BigInt(value) / 1_000_000n);
  else if (typeof value === "number" && Number.isFinite(value)) ms = Math.round(value / 1_000_000);
  if (ms === null) throw new Error(`unreadable rescue time: ${String(value)}`);
  return new Date(ms).toISOString();
}

/** null for a rescue whose transfer failed and was refunded: it moved no money. */
function parseRescue(raw: Raw): RescueRecord | null {
  if (raw.refunded === true) return null;
  const { amount } = raw;
  if (typeof amount !== "string" || !UNITS.test(amount)) throw new Error("unreadable rescue amount");
  const at = chainTimeToIso(pick(raw, "at", "timestamp", "at_ns", "timestamp_ns"));
  const quoteId = pick(raw, "quote_id", "quoteId");
  return typeof quoteId === "string" ? { amount, at, quoteId } : { amount, at };
}

/** A call's base64 return value as JSON, or undefined when it returned nothing readable. */
function decodeValue(base64: string | undefined): unknown {
  if (base64 === undefined || base64 === "") return undefined;
  try {
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The vault contract, as contracts/vault/README.md describes it. Given the keeper's own
 * account, a user whose policy names a different keeper reads as having no policy:
 * the vault would refuse this keeper's rescue anyway.
 */
export function createNearVault(
  client: NearClient,
  options: { keeperAccountId?: string; now?: () => Date } = {},
): Required<Vault> {
  const now = options.now ?? (() => new Date());
  return {
    async getPolicy(user) {
      const raw = await client.view("get_policy", { user });
      if (raw === null || raw === undefined) return null;
      const keeper = (raw as Raw).keeper;
      if (options.keeperAccountId !== undefined && keeper !== options.keeperAccountId) return null;
      return parsePolicy(user, raw as Raw);
    },

    async getUsers() {
      const users: string[] = [];
      for (;;) {
        const page = (await client.view("get_users", { from: users.length, limit: USERS_PAGE })) as unknown[] | null;
        for (const user of page ?? []) {
          if (typeof user !== "string" || user === "") throw new Error("unreadable user in get_users");
          users.push(user);
        }
        if ((page?.length ?? 0) < USERS_PAGE) return users;
      }
    },

    async getReserve(user, token) {
      return reserveOf(await client.view("get_reserve", { user }), token);
    },

    /**
     * The rescues of the last 25 hours, oldest first: every one the daily cap and the
     * cooldown can count, and every recent quote id. Read back from the newest, so a long
     * history doesn't make each check slower.
     */
    async getRescues(user) {
      const count = await client.view("get_rescue_count", { user });
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) throw new Error("unreadable rescue count");
      const cutoff = now().getTime() - HISTORY_MS;
      const pages: RescueRecord[][] = [];
      let end = count;
      while (end > 0) {
        const from = Math.max(0, end - RESCUES_PAGE);
        const page = ((await client.view("get_rescues", { user, from, limit: end - from })) as Raw[] | null) ?? [];
        if (page.length === 0) break;
        const times = page.map((raw) => Date.parse(chainTimeToIso(pick(raw, "at", "timestamp", "at_ns", "timestamp_ns"))));
        pages.unshift(page.map(parseRescue).filter((rescue): rescue is RescueRecord => rescue !== null));
        end = from;
        if (Math.min(...times) < cutoff) break;
      }
      return pages.flat();
    },

    async rescue({ user, token, amount, depositAddress, recipient, quoteId, quote, signature }) {
      const { txHash, failure, value } = await client.call("rescue", {
        user,
        token,
        amount,
        deposit_address: depositAddress,
        recipient,
        quote_id: quoteId,
        quote,
        signature,
      });
      if (failure !== null) throw new VaultRejectedError(failure);
      if (value === false) throw new VaultRejectedError(REFUNDED);
      return { txHash };
    },
  };
}

/**
 * NEAR through near-api-js, signing as the keeper. Calls wait for execution, so
 * a contract panic comes back as a failure instead of looking like a success.
 */
export function connectNear(config: {
  rpcUrl: string;
  vaultId: string;
  keeperAccountId: string;
  keeperKey: string;
  viewTimeoutMs?: number;
  callTimeoutMs?: number;
}): NearClient {
  const { rpcUrl, vaultId, keeperAccountId, keeperKey, viewTimeoutMs = VIEW_TIMEOUT_MS, callTimeoutMs = CALL_TIMEOUT_MS } = config;
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const account = new Account(keeperAccountId, provider, keeperKey as KeyPairString);

  return {
    view: (method, args) => withTimeout(provider.callFunction({ contractId: vaultId, method, args }), viewTimeoutMs, `NEAR ${method}`),

    async call(method, args) {
      try {
        const result = await withTimeout(
          account.signAndSendTransaction({
            receiverId: vaultId,
            // No deposit: the keeper's function-call key couldn't attach one anyway.
            actions: [actions.functionCall(method, args, teraToGas(RESCUE_GAS_TGAS), 0n)],
            waitUntil: "EXECUTED_OPTIMISTIC",
            throwOnFailure: false,
          }),
          callTimeoutMs,
          `NEAR ${method}`,
        );
        const status = result.status as { Failure?: unknown; SuccessValue?: string } | string | undefined;
        const failure = typeof status === "object" && status?.Failure !== undefined ? JSON.stringify(status.Failure) : null;
        const value = typeof status === "object" ? decodeValue(status.SuccessValue) : undefined;
        return { txHash: result.transaction.hash, failure, ...(value === undefined ? {} : { value }) };
      } catch (error) {
        // The chain refused the transaction outright, so it can't have landed.
        if (error instanceof InvalidTransactionError || error instanceof TransactionExecutionError) {
          throw new VaultRejectedError(error.message);
        }
        throw error;
      }
    },
  };
}
