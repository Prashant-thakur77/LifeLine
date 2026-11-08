import { ASSETS } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import type { Intents, Quote, QuoteParams } from "@lifeline/keeper";
import {
  ATTACKER_HL,
  checkProof,
  formatAttempt,
  explorerFor,
  parseProof,
  rpcFor,
  runEngineAttacks,
  sendContractAttack,
  type AttackProof,
} from "../src/attack";

const NOW = new Date("2026-11-08T15:00:00.000Z");

/** Stands in for 1Click: it signs whatever it's asked for, as the real one does. */
const fakeQuotes = (over: Partial<Quote> = {}, seen: QuoteParams[] = []): Pick<Intents, "getQuote"> => ({
  async getQuote(params) {
    seen.push(params);
    const inUsd = Number(params.amount) / 1e6;
    return {
      quoteId: "corr-1",
      depositAddress: null,
      amountIn: params.amount,
      minAmountOut: String(Math.floor((inUsd * 0.98989 - 0.3153) * 1e8)),
      withdrawFee: "31530000",
      recipient: params.recipient,
      refundTo: params.refundTo,
      destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId,
      quotedAt: NOW.toISOString(),
      ...over,
    };
  },
});

const run = (over: Partial<Parameters<typeof runEngineAttacks>[0]> = {}) =>
  runEngineAttacks({
    quotes: fakeQuotes(),
    tamperedQuote: async () => {
      throw new Error("the quote's signature is invalid");
    },
    now: () => NOW,
    ...over,
  });

const named = (attempts: Awaited<ReturnType<typeof run>>, part: string) => {
  const found = attempts.find((attempt) => attempt.name.toLowerCase().includes(part));
  if (!found) throw new Error(`no attempt named ${part}`);
  return found;
};

describe("the attacks on the policy engine", () => {
  it("allows the honest control, so it isn't just refusing everything", async () => {
    const honest = named(await run(), "honest");
    expect(honest.expected).toBe("allow");
    expect(honest.outcome).toBe("allow");
    expect(honest.reasons).toEqual([]);
  });

  it.each([
    ["attacker's address", "RECIPIENT_MISMATCH"],
    ["refund", "REFUND_MISMATCH"],
    ["hyperevm", "WRONG_DEST_ASSET"],
    ["drain", "OVER_PER_RESCUE"],
    ["paused", "PAUSED"],
    ["cooldown", "COOLDOWN"],
    ["healthy", "NOT_BELOW_TRIGGER"],
    ["stale", "QUOTE_STALE"],
  ])("blocks the %s attack with %s", async (part, reason) => {
    const attempt = named(await run(), part);
    expect(attempt.expected).toBe("block");
    expect(attempt.outcome).toBe("block");
    expect(attempt.by).toBe("policy engine");
    expect(attempt.reasons).toContain(reason);
  });

  it("really asks 1Click to pay the attacker, so the quote is a genuine signed one", async () => {
    const seen: QuoteParams[] = [];
    await run({ quotes: fakeQuotes({}, seen) });
    expect(seen.some((params) => params.recipient === ATTACKER_HL)).toBe(true);
    expect(seen.every((params) => params.dry)).toBe(true);
  });

  it("refuses a quote changed after signing, before the engine ever sees it", async () => {
    const attempt = named(await run(), "after 1click signed");
    expect(attempt.outcome).toBe("block");
    expect(attempt.by).toBe("quote signature");
    expect(attempt.reasons[0]).toMatch(/signature/i);
  });

  it("reports it as not refused if a tampered quote gets through", async () => {
    const quote = await fakeQuotes().getQuote({ amount: "1", recipient: ATTACKER_HL, refundTo: "a.near", dry: true });
    const attempt = named(await run({ tamperedQuote: async () => quote }), "after 1click signed");
    expect(attempt.outcome).toBe("allow");
  });

  it("reports an attack as allowed if the engine were broken, rather than assuming", async () => {
    const attempts = await run({ evaluateFn: () => ({ verdict: "allow", reasons: [] }) });
    expect(named(attempts, "attacker's address").outcome).toBe("allow");
  });
});

describe("formatAttempt", () => {
  it("says what was refused, by what, and why", () => {
    const text = formatAttempt({ name: "Pay the attacker", expected: "block", outcome: "block", by: "policy engine", reasons: ["RECIPIENT_MISMATCH"] });
    expect(text).toContain("REFUSED");
    expect(text).toContain("Pay the attacker");
    expect(text).toContain("policy engine");
    expect(text).toContain("RECIPIENT_MISMATCH");
  });

  it("marks the honest control as allowed", () => {
    expect(formatAttempt({ name: "Honest", expected: "allow", outcome: "allow", by: "policy engine", reasons: [] })).toContain("ALLOWED");
  });

  it("makes a failed defence impossible to miss", () => {
    expect(formatAttempt({ name: "Pay the attacker", expected: "block", outcome: "allow", by: "policy engine", reasons: [] })).toContain("NOT REFUSED");
  });
});

describe("sendContractAttack", () => {
  const quote = { payload: '{"depositAddress":"abc","amountIn":"3000000"}', signature: "ed25519:sig" };
  const config = {
    network: "mainnet" as const,
    vaultId: "vault.team.near",
    keeperAccountId: "keeper.team.near",
    user: "team.near",
    token: "usdc.near",
    hlAddress: "0x1111111111111111111111111111111111111111",
    amount: "3000000",
    quote,
  };

  it("sends a genuine quote's money to the keeper's own account, with the user's real address as recipient", async () => {
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    const proof = await sendContractAttack(
      { view: async () => null, call: async (method, args) => (calls.push({ method, args }), { txHash: "HASH", failure: "Smart contract panicked: BAD_QUOTE: its deposit address isn't the one this rescue pays" }) },
      config,
      () => NOW,
    );
    expect(calls).toEqual([
      {
        method: "rescue",
        args: {
          user: "team.near",
          token: "usdc.near",
          amount: "3000000",
          deposit_address: "keeper.team.near",
          recipient: "0x1111111111111111111111111111111111111111",
          quote_id: "attack-demo",
          quote: quote.payload,
          signature: quote.signature,
        },
      },
    ]);
    expect(proof).toEqual({
      network: "mainnet",
      txHash: "HASH",
      signer: "keeper.team.near",
      vault: "vault.team.near",
      failure: "Smart contract panicked: BAD_QUOTE: its deposit address isn't the one this rescue pays",
      recordedAt: NOW.toISOString(),
    });
  });

  it("raises the alarm if the contract accepts it", async () => {
    await expect(
      sendContractAttack({ view: async () => null, call: async () => ({ txHash: "HASH", failure: null }) }, config, () => NOW),
    ).rejects.toThrow(/ACCEPTED/);
  });
});

describe("parseProof", () => {
  const proof: AttackProof = { network: "mainnet", txHash: "HASH", signer: "keeper.team.near", vault: "vault.team.near", failure: "x", recordedAt: "t" };

  it("reads a good proof", () => {
    expect(parseProof(JSON.stringify(proof))).toEqual(proof);
  });

  it("reads a testnet proof too, and keeps its network", () => {
    const testnet = { ...proof, network: "testnet", signer: "keeper.team.testnet", vault: "vault.team.testnet" };
    expect(parseProof(JSON.stringify(testnet))).toEqual(testnet);
  });

  it.each(["not json", "{}", '{"txHash":7}', "null", '{"network":"betanet","txHash":"H","signer":"s","vault":"v","failure":"f","recordedAt":"t"}'])(
    "is null for %s",
    (text) => {
      expect(parseProof(text)).toBeNull();
    },
  );
});

describe("rpcFor", () => {
  it("asks a public node on the proof's own network", () => {
    expect(rpcFor("mainnet")).toBe("https://free.rpc.fastnear.com");
    expect(rpcFor("testnet")).toBe("https://test.rpc.fastnear.com");
  });

  it("links the proof to the explorer for its network", () => {
    expect(explorerFor({ network: "mainnet", txHash: "H" })).toBe("https://nearblocks.io/txns/H");
    expect(explorerFor({ network: "testnet", txHash: "H" })).toBe("https://testnet.nearblocks.io/txns/H");
  });
});

describe("checkProof, which lets anyone re-check the refusal on chain with no keys", () => {
  const proof: AttackProof = { network: "mainnet", txHash: "HASH", signer: "keeper.team.near", vault: "vault.team.near", failure: "x", recordedAt: "t" };
  const answering = (result: unknown, seen: unknown[] = []) =>
    (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    }) as typeof fetch;

  const failedOnChain = {
    status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: wrong recipient" } } } } },
    transaction: { receiver_id: "vault.team.near", signer_id: "keeper.team.near", hash: "HASH" },
  };

  it("confirms a real on-chain failure, and shows the panic", async () => {
    const seen: unknown[] = [];
    const result = await checkProof(proof, "https://rpc.test", answering(failedOnChain, seen));
    expect(result.refused).toBe(true);
    expect(result.detail).toContain("wrong recipient");
    expect(seen[0]).toMatchObject({ method: "tx", params: { tx_hash: "HASH", sender_account_id: "keeper.team.near" } });
  });

  it("isn't fooled by a transaction that succeeded", async () => {
    const result = await checkProof(proof, "https://rpc.test", answering({ ...failedOnChain, status: { SuccessValue: "" } }));
    expect(result.refused).toBe(false);
  });

  it("isn't fooled by a failure on some other contract", async () => {
    const result = await checkProof(
      proof,
      "https://rpc.test",
      answering({ ...failedOnChain, transaction: { ...failedOnChain.transaction, receiver_id: "other.near" } }),
    );
    expect(result.refused).toBe(false);
  });

  it("tries a dropped connection again, since public nodes drop the odd request", async () => {
    let calls = 0;
    const flaky = (async (url: string, init: RequestInit) => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed");
      return answering(failedOnChain)(url, init);
    }) as typeof fetch;
    const waits: number[] = [];
    const result = await checkProof(proof, "https://rpc.test", flaky, async (ms) => void waits.push(ms));
    expect(result.refused).toBe(true);
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it("gives up after three dropped connections and says why", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(checkProof(proof, "https://rpc.test", down, async () => {})).rejects.toThrow(/fetch failed/);
  });

  it("says it couldn't check when the node has no answer", async () => {
    const empty = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "unknown tx" } }))) as unknown as typeof fetch;
    const result = await checkProof(proof, "https://rpc.test", empty);
    expect(result.refused).toBe(false);
    expect(result.detail).toMatch(/couldn't/i);
  });
});
