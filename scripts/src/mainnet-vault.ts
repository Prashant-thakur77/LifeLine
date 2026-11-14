/**
 * Deploys Lifeline's vault to NEAR mainnet, one step at a time. Real money: run a step only
 * after a human has agreed to that step. Every key comes from .env and is never printed.
 *
 *   pnpm --filter @lifeline/scripts exec tsx src/mainnet-vault.ts keys    make the parent, vault and keeper keys (no transaction)
 *   … s1 | s2 | s3 | s4                                                     one transaction each (see STEPS)
 *   … check                                                                 read back the code hash, config and keeper keys
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { Account, actions, JsonRpcProvider, KeyPair, teraToGas, type KeyPairString } from "near-api-js";

export const RPC = "https://free.rpc.fastnear.com";
export const PARENT = "lifeline-hq.near";
export const VAULT = `vault.${PARENT}`;
export const KEEPER = `keeper.${PARENT}`;
/** The reproducible build of commit 37e98488, the code vault.lifeline-team.testnet runs. */
export const CODE_HASH = "FUWd4fuXeaL5eu5k6YfkmufXfm7T8uq7gDD6PvuuzAnq";
export const INIT_ARGS = {
  tokens: ["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "wrap.near"],
  quote_signer: "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc",
};
const NEAR = 10n ** 24n;
export const FUNDING = { parent: (255n * NEAR) / 100n, vault: (247n * NEAR) / 100n, vaultTopUp: (8n * NEAR) / 100n, keeper: (3n * NEAR) / 100n };

/** A NEAR code hash: base58 of the wasm's SHA-256. */
export const codeHash = (wasm: Uint8Array) => base58.encode(sha256(wasm));

const ENV_FILE = new URL("../../.env", import.meta.url);
const KEY_NAMES = { parent: "MAINNET_PARENT_PRIVATE_KEY", vault: "MAINNET_VAULT_PRIVATE_KEY", keeper: "MAINNET_KEEPER_PRIVATE_KEY" } as const;

function env(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(ENV_FILE, "utf8")
      .split(/\r?\n/)
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
  );
}

function key(name: string): KeyPairString {
  const value = env()[name];
  if (!value?.startsWith("ed25519:")) throw new Error(`${name} isn't in .env: run "keys" first`);
  return value as KeyPairString;
}
const publicKeyOf = (name: string) => KeyPair.fromString(key(name)).getPublicKey();

const provider = new JsonRpcProvider({ url: RPC });
const rpc = async (method: string, params: unknown) => {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await response.json()) as { result?: Record<string, unknown>; error?: { cause?: { name?: string } } };
};
const exists = async (accountId: string) => (await rpc("query", { request_type: "view_account", finality: "final", account_id: accountId })).result !== undefined;

async function send(signerId: string, keyName: string, receiverId: string, list: ReturnType<typeof actions.transfer>[]) {
  const account = new Account(signerId, provider, key(keyName));
  const result = await account.signAndSendTransaction({ receiverId, actions: list, waitUntil: "FINAL", throwOnFailure: false });
  const status = result.status as { Failure?: unknown } | string;
  const failed = typeof status === "object" && status.Failure !== undefined;
  const receiptFailures = result.receipts_outcome.filter((o) => typeof o.outcome.status === "object" && "Failure" in o.outcome.status);
  console.log(`  tx ${result.transaction.hash}: ${failed || receiptFailures.length > 0 ? "FAILED" : "ok"}`);
  console.log(`  https://nearblocks.io/txns/${result.transaction.hash}`);
  if (failed || receiptFailures.length > 0) throw new Error(JSON.stringify(failed ? status : receiptFailures[0]!.outcome.status));
  return result.transaction.hash;
}

const STEPS: Record<string, () => Promise<void>> = {
  /** No transaction: three new keys into .env. Prints only the public keys. */
  async keys() {
    let text = readFileSync(ENV_FILE, "utf8");
    if (!text.endsWith("\n")) text += "\n";
    for (const [role, name] of Object.entries(KEY_NAMES)) {
      if (new RegExp(`^${name}=`, "m").test(text)) {
        console.log(`  ${role}: already in .env`);
        continue;
      }
      const pair = KeyPair.fromRandom("ed25519");
      text += `${name}=${pair.toString()}\n`;
      console.log(`  ${role}: ${pair.getPublicKey().toString()}`);
    }
    writeFileSync(ENV_FILE, text);
  },

  /** S1: the implicit account asks the `near` registrar to create the parent, funded. */
  async s1() {
    if (await exists(PARENT)) throw new Error(`${PARENT} already exists`);
    const implicit = env().MAINNET_NEAR_ACCOUNT!;
    await send(implicit, "MAINNET_NEAR_PRIVATE_KEY", "near", [
      actions.functionCall("create_account", { new_account_id: PARENT, new_public_key: publicKeyOf(KEY_NAMES.parent).toString() }, teraToGas(100), FUNDING.parent),
    ]);
  },

  /** S2: the parent creates the vault account with its own full-access key. */
  async s2() {
    if (await exists(VAULT)) throw new Error(`${VAULT} already exists`);
    await send(PARENT, KEY_NAMES.parent, VAULT, [actions.createAccount(), actions.transfer(FUNDING.vault), actions.addFullAccessKey(publicKeyOf(KEY_NAMES.vault))]);
  },

  /**
   * S2b: tops the vault up. Its storage is about 2.41 NEAR (240,918 bytes once deployed), but
   * the deploy transaction also holds back its whole prepaid gas while it runs, so the first
   * S3, with 2.47 NEAR, failed with LackBalanceForState, 0.006 NEAR short.
   */
  async s2b() {
    if (!(await exists(VAULT))) throw new Error(`${VAULT} doesn't exist yet`);
    await send(env().MAINNET_NEAR_ACCOUNT!, "MAINNET_NEAR_PRIVATE_KEY", VAULT, [actions.transfer(FUNDING.vaultTopUp)]);
  },

  /** S3: the vault deploys the hash-checked wasm and initialises itself (`new` is private). */
  async s3() {
    const path = process.env.VAULT_WASM ?? "E:/blockchain/ll-logs/vault-wasm/testnet-vault.wasm";
    if (!existsSync(path)) throw new Error(`no wasm at ${path}`);
    const wasm = readFileSync(path);
    if (codeHash(wasm) !== CODE_HASH) throw new Error(`refusing to deploy: ${path} hashes to ${codeHash(wasm)}, not ${CODE_HASH}`);
    console.log(`  deploying ${wasm.length} bytes, code hash ${CODE_HASH}`);
    await send(VAULT, KEY_NAMES.vault, VAULT, [actions.deployContract(wasm), actions.functionCall("new", INIT_ARGS, teraToGas(50), 0n)]);
  },

  /** S4: the parent creates the keeper with one key only, which can call `rescue` on the vault and nothing else. */
  async s4() {
    if (await exists(KEEPER)) throw new Error(`${KEEPER} already exists`);
    await send(PARENT, KEY_NAMES.parent, KEEPER, [
      actions.createAccount(),
      actions.transfer(FUNDING.keeper),
      actions.addFunctionCallAccessKey(publicKeyOf(KEY_NAMES.keeper), VAULT, ["rescue"]),
    ]);
  },

  /** Read-only: what the chain says now. */
  async check() {
    for (const accountId of [env().MAINNET_NEAR_ACCOUNT!, PARENT, VAULT, KEEPER]) {
      const view = (await rpc("query", { request_type: "view_account", finality: "final", account_id: accountId })).result as { amount: string; code_hash: string; storage_usage: number } | undefined;
      if (!view) {
        console.log(`  ${accountId}: doesn't exist`);
        continue;
      }
      const keys = ((await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: accountId })).result as { keys: { public_key: string; access_key: { permission: unknown } }[] }).keys;
      const near = (Number(BigInt(view.amount) / 10n ** 20n) / 1e4).toFixed(4);
      console.log(`  ${accountId}: ${near} NEAR, ${view.storage_usage} bytes, code_hash ${view.code_hash}`);
      for (const k of keys) console.log(`    key ${k.public_key}: ${JSON.stringify(k.access_key.permission)}`);
    }
    if (await exists(VAULT)) {
      const config = await provider.callFunction({ contractId: VAULT, method: "get_config", args: {} }).catch((error: unknown) => `not initialised: ${String(error).slice(0, 120)}`);
      console.log(`  ${VAULT} get_config: ${JSON.stringify(config)}`);
    }
  },
};

const step = process.argv[2] ?? "";
// Run only as a script, so a test can import the constants without sending anything.
if (process.argv[1]?.endsWith("mainnet-vault.ts")) {
  const run = STEPS[step];
  if (!run) {
    console.error(`usage: mainnet-vault.ts ${Object.keys(STEPS).join(" | ")}`);
    process.exit(1);
  }
  console.log(`${step} (mainnet)`);
  run().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(`  stopped: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
