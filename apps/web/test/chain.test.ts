import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_USER, SIM_KEEPER_URL, keeperUrlFor, networkLabel, readConfig } from "../src/lib/config";
import { KeeperError, keeper, keeperError } from "../src/lib/keeper";
import { RpcError, decodeResult, encodeArgs, outcomeFailure, outcomeHash, outcomeSettled, outcomeValue, parseViewResponse, viewFunction } from "../src/lib/near-rpc";
import { depositBounced, describeTxError, isUserCancel, txResult, withdrawRefunded } from "../src/lib/tx";
import {
  ONE_YOCTO,
  REGISTRATION_DEPOSIT,
  depositTx,
  nsToIso,
  pauseTx,
  registerTokenTx,
  setPolicyTx,
  unpauseTx,
  withdrawTx,
} from "../src/lib/vault";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

afterEach(() => vi.unstubAllGlobals());

describe("networkLabel", () => {
  it("calls the default hosted dashboard the simulation, never mainnet, while no mainnet vault is set", () => {
    expect(networkLabel(readConfig({}))).toBe("Simulation · live mainnet prices");
  });

  it("says testnet on testnet, with or without a vault", () => {
    expect(networkLabel({ network: "testnet", vaultId: null })).toBe("testnet");
    expect(networkLabel({ network: "testnet", vaultId: "vault.lifeline-team.testnet" })).toBe("testnet");
  });

  it("says testnet for a testnet vault even if the network was left at mainnet", () => {
    expect(networkLabel({ network: "mainnet", vaultId: "vault.lifeline-team.testnet" })).toBe("testnet");
  });

  it("says mainnet only once a mainnet vault is set", () => {
    expect(networkLabel({ network: "mainnet", vaultId: "vault.lifeline-team.near" })).toBe("mainnet");
  });
});

describe("readConfig", () => {
  it("defaults to the hosted sim keeper on mainnet, with no vault or keeper account", () => {
    expect(readConfig({})).toEqual({
      keeperApiUrl: SIM_KEEPER_URL,
      simKeeperApiUrl: SIM_KEEPER_URL,
      network: "mainnet",
      rpcUrl: "https://free.rpc.fastnear.com",
      vaultId: null,
      keeperAccountId: null,
      usdcContractId: USDC,
    });
  });
  it("reads every setting, trimming spaces and trailing slashes", () => {
    expect(
      readConfig({
        NEXT_PUBLIC_KEEPER_API_URL: " https://lifeline-keeper.prashantthakur.dev/ ",
        NEXT_PUBLIC_NEAR_NETWORK: "testnet",
        NEXT_PUBLIC_VAULT_ID: "vault.lifeline.testnet",
        NEXT_PUBLIC_KEEPER_ACCOUNT_ID: "keeper.lifeline.testnet",
        NEXT_PUBLIC_USDC_CONTRACT_ID: "usdc.fakes.testnet",
      }),
    ).toMatchObject({
      keeperApiUrl: "https://lifeline-keeper.prashantthakur.dev",
      network: "testnet",
      rpcUrl: "https://test.rpc.fastnear.com",
      vaultId: "vault.lifeline.testnet",
      keeperAccountId: "keeper.lifeline.testnet",
      usdcContractId: "usdc.fakes.testnet",
    });
  });
  it("treats an empty value as unset", () => {
    expect(readConfig({ NEXT_PUBLIC_VAULT_ID: "", NEXT_PUBLIC_NEAR_RPC_URL: "  " })).toMatchObject({ vaultId: null, rpcUrl: "https://free.rpc.fastnear.com" });
  });
  it("refuses an unknown network instead of guessing", () => {
    expect(() => readConfig({ NEXT_PUBLIC_NEAR_NETWORK: "betanet" })).toThrow(/mainnet or testnet/);
  });
  it("always reads the demo account from the sim keeper", () => {
    const config = readConfig({ NEXT_PUBLIC_KEEPER_API_URL: "https://lifeline-keeper.prashantthakur.dev" });
    expect(keeperUrlFor(config, DEMO_USER)).toBe(SIM_KEEPER_URL);
    expect(keeperUrlFor(config, "alice.near")).toBe("https://lifeline-keeper.prashantthakur.dev");
  });
});

describe("keeperError", () => {
  it("maps each keeper error to something to do about it", () => {
    expect(keeperError(404, { error: "this user isn't being watched" })).toMatchObject({ kind: "not-watched", status: 404 });
    expect(keeperError(503, { error: "the Telegram bot isn't set up" }).kind).toBe("no-bot");
    expect(keeperError(429, { error: "too many link codes for this account; try again in a few minutes" }).message).toBe(
      "Too many link codes for this account; try again in a few minutes.",
    );
    expect(keeperError(400, { error: "user must be a NEAR account" }).message).toBe("The keeper refused the request: user must be a NEAR account.");
    expect(keeperError(500, { error: "internal error" }).kind).toBe("server");
    expect(keeperError(502, null).kind).toBe("server");
  });

  it("reports an unreachable keeper as such", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(keeper.stats("https://k")).rejects.toMatchObject({ kind: "unreachable", status: null });
  });

  it("calls the documented paths, encoding the account", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await keeper.audit("https://k", "a b.near", 20);
    await keeper.health("https://k", "demo.near");
    await keeper.telegramLink("https://k", "demo.near");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["https://k/api/audit?user=a%20b.near&limit=20", "https://k/api/health/demo.near", "https://k/api/telegram/link"]);
    const init = fetchMock.mock.calls[2]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ user: "demo.near" });
  });

  it("turns an error body into a KeeperError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "this user isn't being watched" }), { status: 404 })));
    const error = await keeper.health("https://k", "nobody.near").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeeperError);
    expect((error as KeeperError).kind).toBe("not-watched");
  });
});

describe("near-rpc", () => {
  it("encodes arguments as base64 JSON and decodes byte results", () => {
    expect(encodeArgs({})).toBe("e30=");
    expect(encodeArgs({ user: "near" })).toBe("eyJ1c2VyIjoibmVhciJ9");
    expect(decodeResult([110, 117, 108, 108])).toBeNull();
    const bytes = Array.from(new TextEncoder().encode('{"min":"1250000000000000000000"}'));
    expect(decodeResult(bytes)).toEqual({ min: "1250000000000000000000" });
  });

  it("keeps non-ASCII text intact", () => {
    const encoded = encodeArgs({ msg: "über ✓" });
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
    expect(JSON.parse(decoded)).toEqual({ msg: "über ✓" });
  });

  it("reads a missing account and a contract error from real RPC answers", () => {
    const unknownAccount = {
      error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, message: "Server error", data: "account no-such.near does not exist while viewing" },
    };
    expect(() => parseViewResponse(unknownAccount)).toThrow(RpcError);
    expect(() => parseViewResponse(unknownAccount)).toThrow("That account doesn't exist on this network.");
    const contractError = { result: { error: "wasm execution failed with error: MethodResolveError(MethodNotFound)" } };
    expect(() => parseViewResponse(contractError)).toThrow(/MethodNotFound/);
    expect(parseViewResponse({ result: { result: [91, 93] } })).toEqual([]);
  });

  it("sends a call_function query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { result: [34, 53, 34] } })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(viewFunction("https://rpc", USDC, "ft_balance_of", { account_id: "a.near" })).resolves.toBe("5");
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.params).toEqual({
      request_type: "call_function",
      finality: "optimistic",
      account_id: USDC,
      method_name: "ft_balance_of",
      args_base64: encodeArgs({ account_id: "a.near" }),
    });
  });

  it("reads a wallet's transaction outcome", () => {
    const ok = { status: { SuccessValue: btoa('"10000000"') }, transaction: { hash: "Hash1" } };
    expect(outcomeHash(ok)).toBe("Hash1");
    expect(outcomeFailure(ok)).toBeNull();
    expect(outcomeValue(ok)).toBe("10000000");
    expect(outcomeHash({ transaction_outcome: { id: "Hash2" } })).toBe("Hash2");
    expect(outcomeHash(null)).toBeNull();

    const failed = {
      status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: NO_POLICY: set a policy before depositing" } } } } },
    };
    expect(outcomeFailure(failed)).toBe("NO_POLICY: set a policy before depositing");
    expect(outcomeFailure({ status: { Failure: { InvalidTxError: "Expired" } } })).toBe("The transaction failed on chain.");
    expect(outcomeValue({ status: { SuccessValue: "" } })).toBeNull();
  });
});

describe("wallet results", () => {
  it("stays quiet when the user closes the wallet", () => {
    expect(isUserCancel(new Error("User rejected the request"))).toBe(true);
    expect(isUserCancel(new Error("Wallet closed"))).toBe(true);
    expect(describeTxError(new Error("User cancelled"))).toBeNull();
  });
  it("pulls the contract's own message out of a panic", () => {
    expect(describeTxError(new Error('{"ExecutionError":"Smart contract panicked: attach 0.05 NEAR the first time, for your storage in the vault"}'))).toBe(
      "attach 0.05 NEAR the first time, for your storage in the vault",
    );
    expect(describeTxError(new Error("Not enough balance"))).toBe("The wallet reported: Not enough balance");
    expect(describeTxError({})).toBe("The wallet couldn't send the transaction.");
  });
  it("reads hash and failure from an outcome", () => {
    expect(txResult({ status: { SuccessValue: "" }, transaction: { hash: "H" } })).toEqual({ hash: "H", failure: null });
  });
  it("never calls an outcome that doesn't say how it ended a success", () => {
    for (const unsettled of [undefined, null, {}, { status: "Started" }, { status: {} }]) {
      expect(outcomeSettled(unsettled as never), JSON.stringify(unsettled)).toBe(false);
      expect(txResult(unsettled as never).failure, JSON.stringify(unsettled)).toMatch(/didn't say how the transaction ended/);
    }
    expect(outcomeSettled({ status: { Failure: {} } })).toBe(true);
  });
  it("spots a withdrawal the vault refunded: the callback returned false", () => {
    expect(withdrawRefunded({ status: { SuccessValue: btoa("false") } })).toBe(true);
    expect(withdrawRefunded({ status: { SuccessValue: btoa("true") } })).toBe(false);
    expect(withdrawRefunded({ status: { SuccessValue: "" } })).toBe(false);
  });
  it("spots a deposit the vault bounced: ft_transfer_call returned 0 used", () => {
    expect(depositBounced({ status: { SuccessValue: btoa('"0"') } })).toBe(true);
    expect(depositBounced({ status: { SuccessValue: btoa('"10000000"') } })).toBe(false);
    expect(depositBounced({ status: { SuccessValue: "" } })).toBe(false);
  });
});

describe("vault transactions", () => {
  const policy = {
    hl_address: "0x1111111111111111111111111111111111111111",
    keeper: "keeper.lifeline.near",
    warn: 1.8,
    trigger: 1.5,
    target: 2,
    max_per_rescue: "25000000",
    max_per_day: "50000000",
    cooldown_sec: 120,
  };

  it("attaches 0.05 NEAR to the first set_policy and 1 yoctoNEAR after", () => {
    expect(REGISTRATION_DEPOSIT).toBe((5n * 10n ** 22n).toString());
    expect(setPolicyTx("vault.near", policy, true)).toEqual({
      receiverId: "vault.near",
      actions: [{ type: "FunctionCall", params: { methodName: "set_policy", args: { policy }, gas: "30000000000000", deposit: REGISTRATION_DEPOSIT } }],
    });
    expect(setPolicyTx("vault.near", policy, false).actions[0]!.params.deposit).toBe(ONE_YOCTO);
  });

  it("pauses with no deposit, and unpauses and withdraws with 1 yoctoNEAR", () => {
    expect(pauseTx("vault.near").actions[0]!.params).toMatchObject({ methodName: "pause", args: {}, deposit: "0" });
    expect(unpauseTx("vault.near").actions[0]!.params).toMatchObject({ methodName: "unpause", deposit: "1" });
    expect(withdrawTx("vault.near", USDC, "5000000")).toEqual({
      receiverId: "vault.near",
      actions: [{ type: "FunctionCall", params: { methodName: "withdraw", args: { token: USDC, amount: "5000000" }, gas: "50000000000000", deposit: "1" } }],
    });
  });

  it("deposits with ft_transfer_call on the token, to the vault, with an empty msg", () => {
    expect(depositTx(USDC, "vault.near", "10000000")).toEqual({
      receiverId: USDC,
      actions: [
        {
          type: "FunctionCall",
          params: { methodName: "ft_transfer_call", args: { receiver_id: "vault.near", amount: "10000000", msg: "" }, gas: "100000000000000", deposit: "1" },
        },
      ],
    });
  });

  it("registers with a token through storage_deposit", () => {
    expect(registerTokenTx(USDC, "alice.near", "1250000000000000000000").actions[0]!.params).toEqual({
      methodName: "storage_deposit",
      args: { account_id: "alice.near", registration_only: true },
      gas: "30000000000000",
      deposit: "1250000000000000000000",
    });
  });

  it("converts the vault's nanosecond times", () => {
    expect(nsToIso("1762613712000000000")).toBe("2025-11-08T14:55:12.000Z");
    expect(nsToIso("abc")).toBeNull();
  });
});
