import { POLICY_RANGES, type Policy } from "@lifeline/shared";
import { Account, actions, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";
import { InvalidTransactionError } from "near-api-js/rpc-errors";
import { VaultRejectedError, type Vault } from "./ports";

const RESCUE_GAS_TGAS = "100";
const RESCUES_PAGE = 100;
const UNITS = /^\d+$/;

/** The two things the vault adapter needs from NEAR. */
export type NearClient = {
  view(method: string, args: Record<string, unknown>): Promise<unknown>;
  /** `failure` means the chain ran it and it failed. A throw means the outcome is unknown. */
  call(method: string, args: Record<string, unknown>): Promise<{ txHash: string; failure: string | null }>;
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

function parseRescue(raw: Raw): { amount: string; at: string } {
  const { amount } = raw;
  if (typeof amount !== "string" || !UNITS.test(amount)) throw new Error("unreadable rescue amount");
  return { amount, at: chainTimeToIso(pick(raw, "at", "timestamp", "at_ns", "timestamp_ns")) };
}

/** The vault contract, as the shared method table describes it. */
export function createNearVault(client: NearClient): Vault {
  return {
    async getPolicy(user) {
      const raw = await client.view("get_policy", { user });
      return raw === null || raw === undefined ? null : parsePolicy(user, raw as Raw);
    },

    async getReserve(user, token) {
      return reserveOf(await client.view("get_reserve", { user }), token);
    },

    async getRescues(user) {
      const rescues: { amount: string; at: string }[] = [];
      for (;;) {
        const page = (await client.view("get_rescues", { user, from: rescues.length, limit: RESCUES_PAGE })) as Raw[] | null;
        rescues.push(...(page ?? []).map(parseRescue));
        if ((page?.length ?? 0) < RESCUES_PAGE) return rescues;
      }
    },

    async rescue({ user, token, amount, depositAddress, recipient, quoteId }) {
      const { txHash, failure } = await client.call("rescue", {
        user,
        token,
        amount,
        deposit_address: depositAddress,
        recipient,
        quote_id: quoteId,
      });
      if (failure !== null) throw new VaultRejectedError(failure);
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
}): NearClient {
  const { rpcUrl, vaultId, keeperAccountId, keeperKey } = config;
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const account = new Account(keeperAccountId, provider, keeperKey as KeyPairString);

  return {
    view: (method, args) => provider.callFunction({ contractId: vaultId, method, args }),

    async call(method, args) {
      try {
        const result = await account.signAndSendTransaction({
          receiverId: vaultId,
          // No deposit: the keeper's function-call key couldn't attach one anyway.
          actions: [actions.functionCall(method, args, teraToGas(RESCUE_GAS_TGAS), 0n)],
          waitUntil: "EXECUTED_OPTIMISTIC",
          throwOnFailure: false,
        });
        const status = result.status as { Failure?: unknown } | string | undefined;
        const failure = typeof status === "object" && status?.Failure !== undefined ? JSON.stringify(status.Failure) : null;
        return { txHash: result.transaction.hash, failure };
      } catch (error) {
        // The chain refused the transaction outright, so it can't have landed.
        if (error instanceof InvalidTransactionError) throw new VaultRejectedError(error.message);
        throw error;
      }
    },
  };
}
