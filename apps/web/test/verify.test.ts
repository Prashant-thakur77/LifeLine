import { describe, expect, it } from "vitest";
import { REFUSED_RESCUE } from "../src/lib/proof";
import {
  DEPLOYMENTS,
  ONE_CLICK_QUOTE_SIGNER,
  VAULT_CODE_HASH,
  calls,
  curlFor,
  describePermission,
  judgeKeeperKeys,
  judgeRefusal,
  judgeVaultCode,
  judgeVaultConfig,
  judgeVaultKeys,
  NO_CODE_HASH,
  nearAmount,
  snapshotCommit,
  rpc,
  viewResult,
  type AccessKeyInfo,
  type SourceMetadata,
  type TxStatus,
  type Deployment,
  type VaultConfig,
} from "../src/lib/verify";

const VAULT = "vault.lifeline-team.testnet";
const testnet = DEPLOYMENTS.find((d) => d.network === "testnet")!;

// Answers testnet's node gave on 2026-11-09.
const keeperKeys: AccessKeyInfo[] = [
  {
    public_key: "ed25519:H84VL8fNqUNEbXk4mWzMexample",
    access_key: { nonce: 1, permission: { FunctionCall: { allowance: "462134464218885000000000", method_names: ["rescue"], receiver_id: VAULT } } },
  },
];
const fullKey: AccessKeyInfo = { public_key: "ed25519:BJguysEG3qV9example", access_key: { nonce: 1, permission: "FullAccess" } };
const config: VaultConfig = {
  tokens: ["usdc.lifeline-team.testnet"],
  rescue_token: "usdc.lifeline-team.testnet",
  quote_signer: "ed25519:82DdwitgHq5bvhASvXLPn2Anwc2YtJthFYXv616pej8U",
  destination_asset: "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054",
  max_quote_age_sec: 120,
};
const b64 = (value: unknown) => btoa(JSON.stringify(value));
/** The refused rescue as testnet's node returns it (trimmed to the fields the check reads). */
const refusedTx: TxStatus = {
  status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${REFUSED_RESCUE.panic}` } } } } },
  transaction: {
    signer_id: "keeper.lifeline-team.testnet",
    public_key: "ed25519:H84VL8fNqUNEbXk4mWzMexample",
    receiver_id: VAULT,
    actions: [{ FunctionCall: { method_name: "rescue", args: b64({ user: "alice.lifeline-team.testnet", deposit_address: "keeper.lifeline-team.testnet", recipient: "0x1111111111111111111111111111111111111111" }) } }],
  },
  receipts_outcome: [
    { outcome: { executor_id: VAULT, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${REFUSED_RESCUE.panic}` } } } } } } },
    { outcome: { executor_id: "keeper.lifeline-team.testnet", status: { SuccessValue: "" } } },
  ],
};
const expectedRefusal = { keeper: "keeper.lifeline-team.testnet", vault: VAULT, panic: REFUSED_RESCUE.panic };
const noCode = { amount: "1", code_hash: NO_CODE_HASH, storage_usage: 1 };
const reproducible: SourceMetadata = {
  version: "0.1.0",
  link: "https://github.com/Prashant-thakur77/LifeLine/tree/134fd8813baf2d5620f7d4ff24295fc733db2fb4",
  build_info: {
    build_environment: "sourcescan/cargo-near:0.22.0-rust-1.99.1@sha256:c9655eaf7436b90c87ea8b25739f91063032c5c30ba24cfeafe72c142943b5bb",
    build_command: ["cargo", "near", "build", "non-reproducible-wasm", "--locked"],
    contract_path: "contracts/vault",
    source_code_snapshot: "git+https://github.com/Prashant-thakur77/LifeLine?rev=134fd8813baf2d5620f7d4ff24295fc733db2fb4",
  },
};

const rescueKey = (receiver: string, methods: string[]): AccessKeyInfo => ({
  public_key: "ed25519:x",
  access_key: { nonce: 1, permission: { FunctionCall: { allowance: null, method_names: methods, receiver_id: receiver } } },
});

describe("the testnet deployment", () => {
  it("names the refused attack the dashboard shows", () => {
    expect(testnet.refusal).toEqual({ txHash: REFUSED_RESCUE.txHash, signer: REFUSED_RESCUE.signer, panic: REFUSED_RESCUE.panic });
    expect(testnet.vaultCodeHash).toBe(VAULT_CODE_HASH);
    expect(testnet.quoteSigner.isOneClick).toBe(false);
  });
});

describe("judgeKeeperKeys", () => {
  it("proves a keeper whose only key calls rescue on the vault, and whose account has no code", () => {
    const judged = judgeKeeperKeys(keeperKeys, VAULT, noCode);
    expect(judged.verdict).toBe("proven");
    expect(judged.facts[0]?.[1]).toBe(`can only call rescue on ${VAULT} (gas allowance 0.4621 NEAR)`);
  });

  it("fails a full-access key, another method, another contract, any method, or no key at all", () => {
    expect(judgeKeeperKeys([...keeperKeys, fullKey], VAULT, noCode).verdict).toBe("failed");
    expect(judgeKeeperKeys([rescueKey(VAULT, ["rescue", "withdraw"])], VAULT, noCode).verdict).toBe("failed");
    expect(judgeKeeperKeys([rescueKey("usdc.lifeline-team.testnet", ["rescue"])], VAULT, noCode).verdict).toBe("failed");
    expect(judgeKeeperKeys([rescueKey(VAULT, [])], VAULT, noCode).verdict).toBe("failed");
    expect(judgeKeeperKeys([], VAULT, noCode).verdict).toBe("failed");
  });

  it("fails a keeper account with contract code, which could add itself a key", () => {
    expect(judgeKeeperKeys(keeperKeys, VAULT, { ...noCode, code_hash: VAULT_CODE_HASH }).verdict).toBe("failed");
  });
});

describe("judgeVaultCode", () => {
  const onChain = { amount: "1", code_hash: VAULT_CODE_HASH, storage_usage: 1 };

  it("calls our own non-reproducible build trusted: a match only says we built it", () => {
    const judged = judgeVaultCode(onChain, { version: "0.1.0", build_info: null }, VAULT_CODE_HASH);
    expect(judged.verdict).toBe("trusted");
    expect(judged.finding).toMatch(/reproducible/);
    expect(judgeVaultCode(onChain, null, VAULT_CODE_HASH).verdict).toBe("trusted");
  });

  it("proves a reproducible build, and says how to repeat it", () => {
    const judged = judgeVaultCode(onChain, reproducible, VAULT_CODE_HASH);
    expect(judged.verdict).toBe("proven");
    expect(judged.facts).toContainEqual([
      "Rebuild with",
      "git checkout 134fd8813baf2d5620f7d4ff24295fc733db2fb4 && cd contracts/vault && cargo near build reproducible-wasm",
    ]);
  });

  it("fails other code, however it says it was built", () => {
    expect(judgeVaultCode({ ...onChain, code_hash: NO_CODE_HASH }, reproducible, VAULT_CODE_HASH).verdict).toBe("failed");
  });

  it("reads only a git snapshot pinned to a full commit", () => {
    expect(snapshotCommit("git+https://github.com/a/b?rev=134fd8813baf2d5620f7d4ff24295fc733db2fb4")).toEqual({
      repo: "https://github.com/a/b",
      commit: "134fd8813baf2d5620f7d4ff24295fc733db2fb4",
    });
    expect(snapshotCommit("git+https://github.com/a/b?rev=main")).toBeNull();
    expect(snapshotCommit("https://github.com/a/b")).toBeNull();
  });
});

describe("judgeVaultKeys", () => {
  it("calls a vault with a full-access key trusted, not proven, and says what would change that", () => {
    const judged = judgeVaultKeys([fullKey]);
    expect(judged.verdict).toBe("trusted");
    expect(judged.finding).toMatch(/could deploy different code/);
  });

  it("calls any remaining function-call key trusted: one on the vault itself can call its private callbacks", () => {
    const judged = judgeVaultKeys([rescueKey(VAULT, ["on_withdraw_transfer"])]);
    expect(judged.verdict).toBe("trusted");
    expect(judged.finding).toMatch(/private callbacks/);
  });

  it("proves only a vault with no keys at all", () => {
    expect(judgeVaultKeys([]).verdict).toBe("proven");
  });
});

describe("judgeVaultConfig", () => {
  it("calls testnet's stand-in quote key trusted, never 1Click's", () => {
    const judged = judgeVaultConfig(config, testnet);
    expect(judged.verdict).toBe("trusted");
    expect(judged.finding).toMatch(/stand-in/);
  });

  it("proves a mainnet vault that trusts 1Click's key", () => {
    const mainnet: Deployment = { ...testnet, network: "mainnet", quoteSigner: { key: ONE_CLICK_QUOTE_SIGNER, isOneClick: true } };
    expect(judgeVaultConfig({ ...config, quote_signer: ONE_CLICK_QUOTE_SIGNER }, mainnet).verdict).toBe("proven");
    expect(judgeVaultConfig(config, mainnet).verdict).toBe("failed");
  });

  it("fails another destination or a longer quote age", () => {
    expect(judgeVaultConfig({ ...config, destination_asset: "1cs_v1:hypercore:erc20:0x1" }, testnet).verdict).toBe("failed");
    expect(judgeVaultConfig({ ...config, max_quote_age_sec: 600 }, testnet).verdict).toBe("failed");
  });
});

describe("judgeRefusal", () => {
  it("proves the vault's refusal of the keeper's rescue that paid itself", () => {
    const judged = judgeRefusal(refusedTx, expectedRefusal);
    expect(judged.verdict).toBe("proven");
    expect(judged.facts).toContainEqual(["Money pointed at", "keeper.lifeline-team.testnet"]);
    expect(judged.facts).toContainEqual(["Refused by", VAULT]);
  });

  it("fails a transaction from another account, to another contract, or another method", () => {
    const t = refusedTx.transaction!;
    expect(judgeRefusal({ ...refusedTx, transaction: { ...t, signer_id: "alice.lifeline-team.testnet" } }, expectedRefusal).verdict).toBe("failed");
    expect(judgeRefusal({ ...refusedTx, transaction: { ...t, receiver_id: "usdc.lifeline-team.testnet" } }, expectedRefusal).verdict).toBe("failed");
    const withdraw = [{ FunctionCall: { method_name: "withdraw", args: t.actions![0] && typeof t.actions![0] === "object" ? t.actions![0].FunctionCall!.args : "" } }];
    expect(judgeRefusal({ ...refusedTx, transaction: { ...t, actions: withdraw } }, expectedRefusal).verdict).toBe("failed");
  });

  it("fails a rescue that didn't point the money at the keeper", () => {
    const honest = [{ FunctionCall: { method_name: "rescue", args: b64({ deposit_address: "a".repeat(64) }) } }];
    expect(judgeRefusal({ ...refusedTx, transaction: { ...refusedTx.transaction!, actions: honest } }, expectedRefusal).verdict).toBe("failed");
  });

  it("fails a transaction that went through, or failed for another reason or elsewhere", () => {
    expect(judgeRefusal({ ...refusedTx, status: { SuccessValue: "" }, receipts_outcome: [] }, expectedRefusal).verdict).toBe("failed");
    const paused = { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: PAUSED: this user has paused rescues" } } } } };
    expect(judgeRefusal({ ...refusedTx, receipts_outcome: [{ outcome: { executor_id: VAULT, status: paused } }] }, expectedRefusal).verdict).toBe("failed");
    const elsewhere = { outcome: { executor_id: "usdc.lifeline-team.testnet", status: refusedTx.receipts_outcome![0]!.outcome!.status! } };
    expect(judgeRefusal({ ...refusedTx, receipts_outcome: [elsewhere] }, expectedRefusal).verdict).toBe("failed");
  });
});

describe("the requests themselves", () => {
  it("are plain JSON-RPC, shown as curl commands anyone can run", () => {
    const command = curlFor("https://test.rpc.fastnear.com", calls.keys("keeper.lifeline-team.testnet"));
    expect(command).toBe(
      `curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":"verify","method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"keeper.lifeline-team.testnet"}}'`,
    );
    expect(calls.view(VAULT, "get_config").params.args_base64).toBe("e30=");
    expect(calls.tx("h", "s")).toEqual({ method: "tx", params: { tx_hash: "h", sender_account_id: "s", wait_until: "FINAL" } });
  });

  it("send exactly that request and hand back the result, or the node's error", async () => {
    let sent: { url: string; body: string } | null = null;
    const ok = (async (url: string, init: RequestInit) => {
      sent = { url, body: String(init.body) };
      return Response.json({ jsonrpc: "2.0", id: "verify", result: { keys: [] } });
    }) as typeof fetch;
    expect(await rpc("https://rpc.test", calls.keys("a.testnet"), ok)).toEqual({ keys: [] });
    expect(JSON.parse(sent!.body)).toEqual({ jsonrpc: "2.0", id: "verify", ...calls.keys("a.testnet") });

    const unknown = (async () => Response.json({ error: { cause: { name: "UNKNOWN_ACCOUNT" }, data: "no such account" } })) as unknown as typeof fetch;
    await expect(rpc("https://rpc.test", calls.account("x.testnet"), unknown)).rejects.toMatchObject({ reason: "UNKNOWN_ACCOUNT" });
    const down = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    await expect(rpc("https://rpc.test", calls.account("x.testnet"), down)).rejects.toThrow(/502/);
  });

  it("decode a view's bytes, and surface a contract error", () => {
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify(config)));
    expect(viewResult({ result: bytes })).toEqual(config);
    expect(() => viewResult({ error: "MethodNotFound" })).toThrow(/MethodNotFound/);
  });
});

describe("plain words for keys and amounts", () => {
  it("say what a key can do", () => {
    expect(describePermission("FullAccess")).toMatch(/deploy code/);
    expect(describePermission({ FunctionCall: { allowance: null, method_names: [], receiver_id: VAULT } })).toBe(
      `can call any method on ${VAULT} (gas allowance no limit)`,
    );
  });

  it("show NEAR to four places", () => {
    expect(nearAmount("462134464218885000000000")).toBe("0.4621 NEAR");
    expect(nearAmount("3513806112272484499999974")).toBe("3.5138 NEAR");
    expect(nearAmount(null)).toBe("no limit");
  });
});
