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

/** The vault built from contracts/vault at commit 4595ece, as deployed on 2026-11-08. */
export const VAULT_CODE_HASH = "HcUE1tpDmd5KzrC4iLEfLBo4c39kqA6t2txP7vzopQZS";

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
export type TxStatus = { status?: { SuccessValue?: string; Failure?: unknown } };

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

/** The keeper's account holds no key that can do anything but call rescue on the vault. */
export function judgeKeeperKeys(keys: AccessKeyInfo[], vault: string): Judged {
  const facts = keys.map((key): [string, string] => [shortKey(key.public_key), describePermission(key.access_key.permission)]);
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
    finding: `Every key the keeper has can call one method, rescue, on ${vault}. It can't withdraw, transfer, change a policy or touch any other contract.`,
    facts,
  };
}

/** The code running at the vault address is the code built from this repo. */
export function judgeVaultCode(account: AccountView, expectedHash: string): Judged {
  const facts: [string, string][] = [
    ["On chain", account.code_hash],
    ["Built from this repo", expectedHash],
  ];
  if (account.code_hash === expectedHash) {
    return { verdict: "proven", finding: "The vault's code on chain is byte for byte the wasm built from this repo.", facts };
  }
  return { verdict: "failed", finding: "The code on chain isn't the build from this repo.", facts };
}

/** Who could replace the vault's code: anyone holding a full-access key to its account. */
export function judgeVaultKeys(keys: AccessKeyInfo[]): Judged {
  const facts = keys.map((key): [string, string] => [shortKey(key.public_key), describePermission(key.access_key.permission)]);
  const full = keys.filter((key) => key.access_key.permission === "FullAccess");
  if (full.length === 0) {
    return { verdict: "proven", finding: "The vault account has no full-access key, so nobody, the team included, can change its code.", facts };
  }
  return {
    verdict: "trusted",
    finding: `The team still holds ${full.length === 1 ? "a full-access key" : `${full.length} full-access keys`} to the vault account, so it could deploy different code. This turns proven once that key is deleted and the vault is locked.`,
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

/** The refused attack really failed on chain, with the vault's own refusal. */
export function judgeRefusal(tx: TxStatus, expectedPanic: string): Judged {
  const failure = tx.status?.Failure;
  const text = failure === undefined ? "" : JSON.stringify(failure);
  const panic = /"ExecutionError":"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]?.replace(/^Smart contract panicked: /, "") ?? null;
  const facts: [string, string][] = [["Outcome", failure === undefined ? "succeeded" : `refused: ${panic ?? "failed"}`]];
  if (panic === expectedPanic) {
    return { verdict: "proven", finding: "The keeper's own key sent a rescue that paid itself, with a quote signed by the key the vault trusts. The vault refused it on chain.", facts };
  }
  return { verdict: "failed", finding: failure === undefined ? "That transaction succeeded: the vault didn't refuse it." : "That transaction failed for another reason.", facts };
}
