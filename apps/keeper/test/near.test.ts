import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { KeyPair } from "near-api-js";
import { afterEach, describe, expect, it } from "vitest";
import { connectNear, createNearVault, type NearClient } from "../src/near";
import { VaultRejectedError } from "../src/ports";
import { HL, USER } from "./helpers";

const rawPolicy = {
  user: USER,
  hl_address: HL,
  warn: 1.8,
  trigger: 1.5,
  target: 2,
  max_per_rescue: "25000000",
  max_per_day: "50000000",
  cooldown_sec: 120,
  paused: false,
  keeper: "keeper.team.near",
};

function fakeClient(views: Record<string, unknown>, call?: NearClient["call"]) {
  const calls: { method: string; args: object }[] = [];
  const client: NearClient = {
    async view(method, args) {
      calls.push({ method, args });
      return views[method];
    },
    call: call ?? (async () => ({ txHash: "tx", failure: null })),
  };
  return { client, calls };
}

describe("getPolicy", () => {
  it("reads the contract's policy into the shared type", async () => {
    const { client, calls } = fakeClient({ get_policy: rawPolicy });
    expect(await createNearVault(client).getPolicy(USER)).toEqual({
      user: USER,
      hlAddress: HL,
      warn: 1.8,
      trigger: 1.5,
      target: 2,
      maxPerRescue: "25000000",
      maxPerDay: "50000000",
      cooldownSec: 120,
      paused: false,
    });
    expect(calls[0]).toEqual({ method: "get_policy", args: { user: USER } });
  });

  it("is null for someone with no policy", async () => {
    const { client } = fakeClient({ get_policy: null });
    expect(await createNearVault(client).getPolicy(USER)).toBeNull();
  });

  it.each([
    ["a missing address", { hl_address: undefined }],
    ["a cap that isn't base units", { max_per_rescue: 25 }],
    ["thresholds on another scale, like 150 for 1.5", { warn: 180, trigger: 150, target: 200 }],
    ["a paused flag that isn't true or false", { paused: "no" }],
  ])("refuses %s rather than acting on it", async (_name, change) => {
    const { client } = fakeClient({ get_policy: { ...rawPolicy, ...change } });
    await expect(createNearVault(client).getPolicy(USER)).rejects.toThrow(/policy/i);
  });
});

describe("getReserve", () => {
  const usdc = "usdc.near";

  it("reads a token from a map", async () => {
    const { client } = fakeClient({ get_reserve: { [usdc]: "7000000" } });
    expect(await createNearVault(client).getReserve(USER, usdc)).toBe("7000000");
  });

  it("reads a token from a list of pairs", async () => {
    const { client } = fakeClient({ get_reserve: [[usdc, "7000000"], ["wrap.near", "1"]] });
    expect(await createNearVault(client).getReserve(USER, usdc)).toBe("7000000");
  });

  it("is zero when the user has none of that token", async () => {
    const { client } = fakeClient({ get_reserve: { "wrap.near": "1" } });
    expect(await createNearVault(client).getReserve(USER, usdc)).toBe("0");
  });

  it("is zero when the user has no reserve at all", async () => {
    const { client } = fakeClient({ get_reserve: null });
    expect(await createNearVault(client).getReserve(USER, usdc)).toBe("0");
  });
});

describe("getRescues", () => {
  it("turns the chain's nanosecond times into ISO", async () => {
    const { client } = fakeClient({
      get_rescues: [{ amount: "5000000", at: "1794155400000000000" }],
    });
    expect(await createNearVault(client).getRescues(USER)).toEqual([
      { amount: "5000000", at: new Date(1794155400000).toISOString() },
    ]);
  });

  it("keeps the quote id, so the keeper can tell whether a rescue landed", async () => {
    const { client } = fakeClient({ get_rescues: [{ amount: "1", at: "1794155400000000000", quote_id: "corr-7" }] });
    expect((await createNearVault(client).getRescues(USER))[0]?.quoteId).toBe("corr-7");
  });

  it("also accepts a field called timestamp, in numbers", async () => {
    const { client } = fakeClient({ get_rescues: [{ amount: "1", timestamp: 1794155400000000000 }] });
    expect((await createNearVault(client).getRescues(USER))[0]?.at).toBe(new Date(1794155400000).toISOString());
  });

  it("reads every page, so no rescue escapes the daily cap", async () => {
    const page = Array.from({ length: 100 }, () => ({ amount: "1", at: "1794155400000000000" }));
    const pages = [page, page.slice(0, 3)];
    const asked: unknown[] = [];
    const client: NearClient = {
      async view(_method, args) {
        asked.push(args);
        return pages.shift() ?? [];
      },
      call: async () => ({ txHash: "tx", failure: null }),
    };
    expect(await createNearVault(client).getRescues(USER)).toHaveLength(103);
    expect(asked).toEqual([
      { user: USER, from: 0, limit: 100 },
      { user: USER, from: 100, limit: 100 },
    ]);
  });

  it("refuses a rescue with an unreadable time, rather than letting it skip the cooldown", async () => {
    const { client } = fakeClient({ get_rescues: [{ amount: "1", at: "soon" }] });
    await expect(createNearVault(client).getRescues(USER)).rejects.toThrow(/time/i);
  });
});

describe("rescue", () => {
  const args = {
    user: USER,
    token: "usdc.near",
    amount: "5000000",
    depositAddress: "deposit-1",
    recipient: HL,
    quoteId: "corr-1",
  };

  it("calls the contract with its own argument names and returns the tx hash", async () => {
    const seen: unknown[] = [];
    const { client } = fakeClient({}, async (method, callArgs) => {
      seen.push([method, callArgs]);
      return { txHash: "tx-9", failure: null };
    });
    expect(await createNearVault(client).rescue(args)).toEqual({ txHash: "tx-9" });
    expect(seen).toEqual([
      [
        "rescue",
        {
          user: USER,
          token: "usdc.near",
          amount: "5000000",
          deposit_address: "deposit-1",
          recipient: HL,
          quote_id: "corr-1",
        },
      ],
    ]);
  });

  it("reports an on-chain refusal as a refusal", async () => {
    const { client } = fakeClient({}, async () => ({ txHash: "tx", failure: "Smart contract panicked: paused" }));
    const rescue = createNearVault(client).rescue(args);
    await expect(rescue).rejects.toBeInstanceOf(VaultRejectedError);
    await expect(rescue).rejects.toThrow("paused");
  });

  it("leaves any other error as unknown, because the transaction may have landed", async () => {
    const { client } = fakeClient({}, async () => {
      throw new Error("RPC timeout");
    });
    const rescue = createNearVault(client).rescue(args);
    await expect(rescue).rejects.not.toBeInstanceOf(VaultRejectedError);
    await expect(rescue).rejects.toThrow("RPC timeout");
  });
});

describe("connectNear, against a stand-in RPC node", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
    server = null;
  });

  async function startRpc(answer: (method: string, params: Record<string, unknown>) => unknown) {
    const methods: string[] = [];
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: Record<string, unknown> };
        methods.push(method);
        const outcome = answer(method, params);
        const reply = (outcome as { error?: unknown }).error ? { id, jsonrpc: "2.0", ...(outcome as object) } : { id, jsonrpc: "2.0", result: outcome };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server?.address() as AddressInfo).port}`, methods };
  }

  const chainAnswers = (txStatus: unknown) => (method: string, params: Record<string, unknown>) => {
    if (method === "query" && params.request_type === "view_access_key") {
      return { block_hash: "11111111111111111111111111111111", block_height: 1, nonce: 1, permission: "FullAccess" };
    }
    if (method === "query" && params.request_type === "call_function") {
      return { block_hash: "11111111111111111111111111111111", block_height: 1, logs: [], result: [...Buffer.from('{"ok":true}')] };
    }
    if (method === "block") {
      return { header: { hash: "11111111111111111111111111111111", height: 1 } };
    }
    if (method === "send_tx") {
      return {
        final_execution_status: "EXECUTED_OPTIMISTIC",
        status: txStatus,
        transaction: { hash: "real-tx-hash" },
        transaction_outcome: { id: "o", outcome: { logs: [], status: {} } },
        receipts_outcome: [],
      };
    }
    return { error: { code: -32601, message: `no ${method}` } };
  };

  const client = (url: string) =>
    connectNear({
      rpcUrl: url,
      vaultId: "vault.team.testnet",
      keeperAccountId: "keeper.team.testnet",
      keeperKey: KeyPair.fromRandom("ed25519").toString(),
    });

  it("reads a view method's JSON", async () => {
    const { url } = await startRpc(chainAnswers({ SuccessValue: "" }));
    expect(await client(url).view("get_policy", { user: USER })).toEqual({ ok: true });
  });

  it("signs a call, waits for execution and returns its hash", async () => {
    const { url, methods } = await startRpc(chainAnswers({ SuccessValue: "" }));
    expect(await client(url).call("rescue", { user: USER })).toEqual({ txHash: "real-tx-hash", failure: null });
    expect(methods).toContain("send_tx");
  });

  it("reports a transaction the chain refused outright as a refusal, not an unknown", async () => {
    const refused = {
      error: {
        code: -32000,
        message: "Server error",
        name: "HANDLER_ERROR",
        cause: { name: "INVALID_TRANSACTION", info: {} },
        data: { TxExecutionError: { InvalidTxError: { ShardCongested: { shard_id: 0, congestion_level: 1 } } } },
      },
    };
    const { url } = await startRpc((method, params) => (method === "send_tx" ? refused : chainAnswers({ SuccessValue: "" })(method, params)));
    await expect(client(url).call("rescue", { user: USER })).rejects.toBeInstanceOf(VaultRejectedError);
  });

  async function startSilentRpc() {
    server = createServer(() => {
      // Never answers.
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
  }

  it("gives up on a silent node, so one stuck read can't stop the watch loop", async () => {
    const url = await startSilentRpc();
    const near = connectNear({
      rpcUrl: url,
      vaultId: "vault.team.testnet",
      keeperAccountId: "keeper.team.testnet",
      keeperKey: KeyPair.fromRandom("ed25519").toString(),
      viewTimeoutMs: 50,
      callTimeoutMs: 50,
    });
    await expect(near.view("get_policy", { user: USER })).rejects.toThrow(/timed out/i);
    await expect(near.call("rescue", { user: USER })).rejects.toThrow(/timed out/i);
    server?.closeAllConnections();
  });

  it("reports a contract panic as a failure, with the hash", async () => {
    const panic = { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: paused" } } } } };
    const { url } = await startRpc(chainAnswers(panic));
    const result = await client(url).call("rescue", { user: USER });
    expect(result.txHash).toBe("real-tx-hash");
    expect(result.failure).toContain("Smart contract panicked: paused");
  });
});
