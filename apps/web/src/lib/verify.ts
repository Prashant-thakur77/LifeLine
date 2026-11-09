import { ASSETS } from "@lifeline/shared";
import type { Network } from "./config";
import { DEFAULT_RPC_URL } from "./config";
import { RpcError } from "./near-rpc";
import { REFUSED_RESCUE } from "./proof";

// Checks anyone can run against a public NEAR node, with no help from Lifeline: each one
// sends a plain JSON-RPC request (https://docs.near.org/api/rpc/introduction) and judges
// the answer here, in the browser. The verify page shows each request so it can be rerun
// with curl.

/** 1Click's quote-signing key, as the vault must trust it on mainnet (checked 2026-11-08). */
export const ONE_CLICK_QUOTE_SIGNER = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

/** What a deployment of the vault and keeper should look like on chain. */
export type Deployment = {
  network: Network;
  rpcUrl: string;
  vault: string;
  keeper: string;
  /** NEAR's code hash (base58 SHA-256) of the vault wasm built from this repo. */
  vaultCodeHash: string;
  /** The one key the vault may accept quotes from, and whose it is. */
  quoteSigner: { key: string; isOneClick: boolean };
  /** A hacked keeper's rescue that the vault refused on this network. */
  refusal: { txHash: string; signer: string; panic: string } | null;
};

/**
 * `cargo near build reproducible-wasm` at commit 37e98488a59ecbfe51e49089846410a7588336e9,
 * deployed to the testnet vault on 2026-11-09. The wasm names that commit itself.
 */
export const VAULT_CODE_HASH = "FUWd4fuXeaL5eu5k6YfkmufXfm7T8uq7gDD6PvuuzAnq";

/**
 * Testnet runs the same vault code, but trusts a stand-in quote key the team holds,
 * because 1Click has no testnet. Mainnet gets added here when it's deployed.
 */
export const DEPLOYMENTS: Deployment[] = [
  {
    network: "testnet",
    rpcUrl: DEFAULT_RPC_URL.testnet,
    vault: "vault.lifeline-team.testnet",
    keeper: "keeper.lifeline-team.testnet",
    vaultCodeHash: VAULT_CODE_HASH,
    quoteSigner: { key: "ed25519:82DdwitgHq5bvhASvXLPn2Anwc2YtJthFYXv616pej8U", isOneClick: false },
    refusal: { txHash: REFUSED_RESCUE.txHash, signer: REFUSED_RESCUE.signer, panic: REFUSED_RESCUE.panic },
  },
];

// ---- What the node answers ----

export type AccessKeyPermission = "FullAccess" | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
export type AccessKeyInfo = { public_key: string; access_key: { nonce: number; permission: AccessKeyPermission } };
export type AccountView = { amount: string; code_hash: string; storage_usage: number };
export type VaultConfig = {
  tokens: string[];
  rescue_token: string;
  quote_signer: string;
  destination_asset: string;
  max_quote_age_sec: number;
};
/** NEP-330: what the contract says about its own source and how it was built. */
export type SourceMetadata = {
  version?: string;
  link?: string;
  build_info?: {
    build_environment: string;
    build_command: string[];
    source_code_snapshot: string;
    contract_path?: string | null;
  } | null;
};
export type TxStatus = {
  status?: { SuccessValue?: string; Failure?: unknown };
  transaction?: {
    signer_id?: string;
    public_key?: string;
    receiver_id?: string;
    actions?: ({ FunctionCall?: { method_name?: string; args?: string } } | string)[];
  };
  receipts_outcome?: { outcome?: { executor_id?: string; status?: { Failure?: unknown; SuccessValue?: string } } }[];
};

/** An account with no contract shows the code hash of empty code. */
export const NO_CODE_HASH = "11111111111111111111111111111111";

/** One JSON-RPC call, written out so it can be shown and copied. */
export type RpcCall = { method: string; params: Record<string, unknown> };

export const calls = {
  account: (accountId: string): RpcCall => ({ method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }),
  keys: (accountId: string): RpcCall => ({ method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: accountId } }),
  view: (accountId: string, method: string, args: unknown = {}): RpcCall => ({
    method: "query",
    params: { request_type: "call_function", finality: "final", account_id: accountId, method_name: method, args_base64: btoa(JSON.stringify(args)) },
  }),
  tx: (hash: string, sender: string): RpcCall => ({ method: "tx", params: { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" } }),
};

const body = (call: RpcCall) => JSON.stringify({ jsonrpc: "2.0", id: "verify", method: call.method, params: call.params });

/** The same request as a shell command, for anyone who'd rather not trust this page either. */
export function curlFor(rpcUrl: string, call: RpcCall): string {
  return `curl -s ${rpcUrl} -H 'content-type: application/json' -d '${body(call)}'`;
}

export async function rpc<T>(rpcUrl: string, call: RpcCall, fetchFn: typeof fetch = fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: body(call), signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new RpcError("Couldn't reach the NEAR node. Check your connection and try again.");
  }
  if (!response.ok) throw new RpcError(`The NEAR node answered with HTTP ${response.status}.`);
  const json = (await response.json()) as { result?: unknown; error?: { cause?: { name?: string }; data?: unknown; message?: string } };
  if (json.error) {
    const detail = typeof json.error.data === "string" ? json.error.data : json.error.message ?? "RPC error";
    throw new RpcError(detail, json.error.cause?.name);
  }
  return json.result as T;
}

/** A view call's result: UTF-8 JSON as an array of bytes. */
export function viewResult<T>(result: { result?: number[]; error?: string }): T {
  if (result.error) throw new RpcError(result.error, "CONTRACT_ERROR");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result ?? []))) as T;
}

// ---- Judging the answers ----

/**
 * proven: the chain says so, checked here. trusted: true today only because the team
 * says so (shown with what would make it proven). failed: the chain contradicts the claim.
 */
export type Verdict = "proven" | "trusted" | "failed";
export type Judged = { verdict: Verdict; finding: string; facts: [label: string, value: string][] };

const YOCTO_PER_NEAR = 10n ** 24n;
export function nearAmount(yocto: string | null): string {
  if (yocto === null) return "no limit";
  const value = BigInt(yocto);
  const whole = value / YOCTO_PER_NEAR;
  const fraction = ((value % YOCTO_PER_NEAR) * 10_000n) / YOCTO_PER_NEAR;
  return `${whole}.${fraction.toString().padStart(4, "0")} NEAR`;
}

const shortKey = (key: string) => (key.length > 22 ? `${key.slice(0, 16)}…${key.slice(-4)}` : key);

export function describePermission(permission: AccessKeyPermission): string {
  if (permission === "FullAccess") return "full access: can do anything, including deploy code";
  const { receiver_id, method_names, allowance } = permission.FunctionCall;
  const what = method_names.length === 0 ? "can call any method" : `can only call ${method_names.join(", ")}`;
  return `${what} on ${receiver_id} (gas allowance ${nearAmount(allowance)})`;
}

/**
 * The keeper's account holds no key that can do anything but call rescue on the vault,
 * and no contract code, which could otherwise add a key to the account itself.
 */
export function judgeKeeperKeys(keys: AccessKeyInfo[], vault: string, account: AccountView): Judged {
  const facts = keys.map((key): [string, string] => [shortKey(key.public_key), describePermission(key.access_key.permission)]);
  facts.push(["Contract code", account.code_hash === NO_CODE_HASH ? "none" : account.code_hash]);
  if (account.code_hash !== NO_CODE_HASH) {
    return { verdict: "failed", finding: "The keeper account has contract code, and code can add keys to its own account, so its keys alone don't settle what it can do.", facts };
  }
  if (keys.length === 0) return { verdict: "failed", finding: "The keeper account has no keys at all, so it couldn't call rescue.", facts };
  const rescueOnly = (permission: AccessKeyPermission) =>
    permission !== "FullAccess" &&
    permission.FunctionCall.receiver_id === vault &&
    permission.FunctionCall.method_names.length === 1 &&
    permission.FunctionCall.method_names[0] === "rescue";
  const bad = keys.filter((key) => !rescueOnly(key.access_key.permission));
  if (bad.length > 0) {
    return {
      verdict: "failed",
      finding: `${bad.length} of the keeper's ${keys.length} keys can do more than call rescue on ${vault}.`,
      facts,
    };
  }
  return {
    verdict: "proven",
    finding: `Every key the keeper has can call one method, rescue, on ${vault}, and its account has no code that could add another. It can't withdraw, transfer, change a policy or touch any other contract.`,
    facts,
  };
}

/** The commit a reproducible build names: `git+<repo>?rev=<commit>`. */
export function snapshotCommit(snapshot: string): { repo: string; commit: string } | null {
  const match = /^git\+(https:\/\/[^?]+)\?rev=([0-9a-f]{40})$/.exec(snapshot);
  return match ? { repo: match[1]!, commit: match[2]! } : null;
}

/**
 * The code at the vault address is a build of this repo that anyone can repeat. A match
 * with our own build only says we built it; a reproducible build (NEP-330 build_info, from
 * a pinned image and a public commit) lets anyone rebuild those bytes and compare.
 */
export function judgeVaultCode(account: AccountView, metadata: SourceMetadata | null, expectedHash: string): Judged {
  const facts: [string, string][] = [
    ["Code hash on chain", account.code_hash],
    ["Our build", expectedHash],
  ];
  if (account.code_hash !== expectedHash) {
    return { verdict: "failed", finding: "The code on chain isn't the build this page expects.", facts };
  }
  const info = metadata?.build_info ?? null;
  const source = info ? snapshotCommit(info.source_code_snapshot) : null;
  if (info === null || source === null) {
    return {
      verdict: "trusted",
      finding:
        "The code on chain is the wasm we built, but not with a reproducible build: it carries paths from our machine, so a rebuild elsewhere gives other bytes. That it came from this repo is our word until the vault is redeployed from a reproducible build.",
      facts,
    };
  }
  facts.push(
    ["Source", `${source.repo} at ${source.commit}`],
    ["Build image", info.build_environment],
    ["Rebuild with", `git checkout ${source.commit} && cd ${info.contract_path || "."} && cargo near build reproducible-wasm`],
  );
  return {
    verdict: "proven",
    finding: "The vault says it was built reproducibly from a public commit, in a pinned image. Rebuild that commit with the command below and you get these exact bytes: the hash on chain.",
    facts,
  };
}

/**
 * Who could act as the vault itself. A full-access key can deploy new code; even a
 * function-call key on the vault's own account could call its private callbacks. So only
 * an account with no keys at all is locked. (The vault's code has no method that deploys.)
 */
export function judgeVaultKeys(keys: AccessKeyInfo[]): Judged {
  const facts = keys.map((key): [string, string] => [shortKey(key.public_key), describePermission(key.access_key.permission)]);
  if (keys.length === 0) {
    return {
      verdict: "proven",
      finding: "The vault account has no keys at all, and its code has no method that deploys new code, so nobody, the team included, can change it or act as it.",
      facts,
    };
  }
  const full = keys.filter((key) => key.access_key.permission === "FullAccess").length;
  return {
    verdict: "trusted",
    finding:
      full > 0
        ? `The team still holds ${full === 1 ? "a full-access key" : `${full} full-access keys`} to the vault account, so it could deploy different code. This turns proven once every key is deleted and the vault is locked.`
        : `The vault account has no full-access key, but ${keys.length === 1 ? "a function-call key remains" : `${keys.length} function-call keys remain`}, and a key on the vault's own account can call its private callbacks. This turns proven once every key is deleted.`,
    facts,
  };
}

/** The vault takes quotes from one key only, for USDC margin on Hyperliquid, and not stale ones. */
export function judgeVaultConfig(config: VaultConfig, deployment: Deployment): Judged {
  const facts: [string, string][] = [
    ["Trusted quote key", config.quote_signer],
    ["Pays out to", config.destination_asset],
    ["Oldest quote it takes", `${config.max_quote_age_sec} s`],
    ["Reserve tokens", config.tokens.join(", ")],
  ];
  const expected = deployment.quoteSigner.key;
  if (config.quote_signer !== expected) {
    return { verdict: "failed", finding: `The vault trusts ${config.quote_signer}, not the expected ${expected}.`, facts };
  }
  if (config.destination_asset !== ASSETS.HYPERLIQUID_USDC.assetId) {
    return { verdict: "failed", finding: "The vault pays out to something other than Hyperliquid perps margin.", facts };
  }
  if (config.max_quote_age_sec > 120) {
    return { verdict: "failed", finding: "The vault accepts quotes older than 2 minutes.", facts };
  }
  if (!deployment.quoteSigner.isOneClick) {
    return {
      verdict: "trusted",
      finding:
        "The vault takes quotes from exactly one key, for Hyperliquid margin, at most 2 minutes old. On testnet that key is a stand-in the team holds, because 1Click has no testnet; on mainnet it must be 1Click's own key.",
      facts,
    };
  }
  return {
    verdict: config.quote_signer === ONE_CLICK_QUOTE_SIGNER ? "proven" : "failed",
    finding: "The vault takes quotes only from 1Click's signing key, only for Hyperliquid margin, and none older than 2 minutes.",
    facts,
  };
}

const panicOf = (failure: unknown): string | null => {
  if (failure === undefined || failure === null) return null;
  const text = JSON.stringify(failure);
  return /"ExecutionError":"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]?.replace(/^Smart contract panicked: /, "") ?? null;
};

function decodeArgs(args: string | undefined): Record<string, unknown> | null {
  if (args === undefined) return null;
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(args), (c) => c.charCodeAt(0)))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The hacked keeper's rescue: signed by the keeper's account, sent to the vault, calling
 * rescue with the keeper's own account as the deposit address, and refused by the vault
 * itself with the expected panic. A node answers for any tx hash whatever sender is
 * named, so every one of these comes from the transaction, not from the request.
 */
export function judgeRefusal(tx: TxStatus, expected: { keeper: string; vault: string; panic: string }): Judged {
  const t = tx.transaction;
  const call = t?.actions?.length === 1 && typeof t.actions[0] === "object" ? t.actions[0].FunctionCall : undefined;
  const args = decodeArgs(call?.args);
  const refusal = tx.receipts_outcome?.find((r) => r.outcome?.status?.Failure !== undefined);
  const panic = panicOf(refusal?.outcome?.status?.Failure);
  const facts: [string, string][] = [
    ["Signed by", `${t?.signer_id ?? "?"} with ${shortKey(t?.public_key ?? "?")}`],
    ["Called", `${call?.method_name ?? "?"} on ${t?.receiver_id ?? "?"}`],
    ["Money pointed at", String(args?.deposit_address ?? "?")],
    ["Refused by", refusal?.outcome?.executor_id ?? "nobody"],
    ["Answer", panic ?? (tx.status?.Failure === undefined ? "it succeeded" : "failed")],
  ];
  const fail = (finding: string): Judged => ({ verdict: "failed", finding, facts });
  if (t?.signer_id !== expected.keeper) return fail("That transaction wasn't sent by the keeper's account.");
  if (t.receiver_id !== expected.vault || call?.method_name !== "rescue") return fail("That transaction wasn't a rescue call to the vault.");
  if (args?.deposit_address !== expected.keeper) return fail("That rescue didn't point the money at the keeper's own account.");
  if (tx.status?.Failure === undefined) return fail("That transaction succeeded: the vault didn't refuse it.");
  if (refusal?.outcome?.executor_id !== expected.vault || panic !== expected.panic) return fail("That transaction failed, but not with the vault's refusal.");
  return {
    verdict: "proven",
    finding:
      "The keeper's own account called rescue with the money pointed at itself. The vault checked the quote's signature first, so the quote was signed by the key it trusts, then refused: the signed quote pays a different deposit address.",
    facts,
  };
}
