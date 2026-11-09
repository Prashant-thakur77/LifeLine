import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  ATTACKER_HL,
  ATTACKS,
  LabBusy,
  LabClosed,
  TESTNET_LAB,
  buildAttack,
  createAttackLab,
  isAttackId,
  panicOf,
  type AttackId,
  type AttackResult,
} from "../src/attack-lab";
import type { NearClient } from "../src/near";

const seed = sha256(new TextEncoder().encode("lab test key"));
const publicKey = ed25519.getPublicKey(seed);
const KEY = `ed25519:${base58.encode(new Uint8Array([...seed, ...publicKey]))}`;
const NOW = new Date("2026-11-09T10:00:00.000Z");
const FRESH = "ab".repeat(32);

const signedByStandIn = (payload: string, signature: string) =>
  ed25519.verify(base58.decode(signature.replace(/^ed25519:/, "")), new TextEncoder().encode(base58.encode(sha256(new TextEncoder().encode(payload)))), publicKey);

const build = (id: AttackId) => buildAttack(id, TESTNET_LAB, { signerKey: KEY, now: NOW, freshDeposit: FRESH });
const quoteOf = (id: AttackId) => JSON.parse(build(id).quote) as Record<string, unknown>;
const honestQuote = quoteOf("pay-itself"); // its quote is the honest one; only the call's deposit address lies

/** The quote fields an attack changed from an honest quote. */
const changed = (id: AttackId) => Object.keys(honestQuote).filter((k) => JSON.stringify(quoteOf(id)[k]) !== JSON.stringify(honestQuote[k]));

describe("buildAttack", () => {
  it("has one attack per id, each with the vault's exact answer", () => {
    expect(ATTACKS.map((a) => a.id)).toEqual(["pay-itself", "pay-attacker", "forged-quote", "over-cap", "stale-quote", "refund-to-itself", "reused-deposit"]);
    expect(isAttackId("pay-itself")).toBe(true);
    expect(isAttackId("drain")).toBe(false);
  });

  it("signs every quote with the stand-in key, except the edited one", () => {
    for (const { id } of ATTACKS) {
      const call = build(id);
      expect(signedByStandIn(call.quote, call.signature), id).toBe(id !== "forged-quote");
    }
  });

  it("keeps the honest quote for 'pay itself', and only points the call at the keeper", () => {
    const call = build("pay-itself");
    expect(call.deposit_address).toBe(TESTNET_LAB.keeper);
    expect(honestQuote).toMatchObject({ depositAddress: FRESH, recipient: TESTNET_LAB.hlAddress, refundTo: TESTNET_LAB.user, amount: "3000000" });
  });

  it("breaks exactly one thing in each other quote", () => {
    expect(changed("pay-attacker")).toEqual(["recipient"]);
    expect(quoteOf("pay-attacker").recipient).toBe(ATTACKER_HL);
    expect(changed("forged-quote")).toEqual(["recipient"]);
    expect(changed("stale-quote")).toEqual(["timestamp"]);
    expect(Date.parse(String(quoteOf("stale-quote").timestamp))).toBe(NOW.getTime() - 10 * 60_000);
    expect(changed("refund-to-itself")).toEqual(["refundTo"]);
    expect(quoteOf("refund-to-itself").refundTo).toBe(TESTNET_LAB.keeper);
    expect(changed("reused-deposit")).toEqual(["depositAddress"]);
    expect(changed("over-cap")).toEqual(["amount", "amountIn", "amountOut", "minAmountOut"]);
  });

  it("keeps the call honest wherever the attack doesn't need to lie", () => {
    for (const { id } of ATTACKS) {
      const call = build(id);
      expect(call.user).toBe(TESTNET_LAB.user);
      expect(call.recipient, id).toBe(TESTNET_LAB.hlAddress);
      expect(call.quote_id).toBe(`lab-${id}-${NOW.getTime()}`);
    }
    expect(build("over-cap").amount).toBe("25000001");
    expect(build("reused-deposit").deposit_address).toBe(TESTNET_LAB.usedDeposit);
    expect(build("forged-quote").deposit_address).toBe(FRESH);
  });
});

describe("panicOf", () => {
  it("reads the vault's answer out of a failure", () => {
    const failure = JSON.stringify({ ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: BAD_QUOTE: it's more than 2 minutes old" } } } });
    expect(panicOf(failure)).toBe("BAD_QUOTE: it's more than 2 minutes old");
    expect(panicOf(null)).toBeNull();
    expect(panicOf('{"ActionError":{}}')).toBeNull();
  });
});

describe("createAttackLab", () => {
  const refusal = (text: string) => JSON.stringify({ ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${text}` } } } });

  function lab(options: { accept?: boolean; saved?: AttackResult[]; perDay?: number; clock?: { t: number } } = {}) {
    const clock = options.clock ?? { t: NOW.getTime() };
    const sent: Record<string, unknown>[] = [];
    const saved: (readonly AttackResult[])[] = [];
    const logs: string[] = [];
    let n = 0;
    const client: NearClient = {
      view: async () => null,
      async call(method, args) {
        expect(method).toBe("rescue");
        sent.push(args);
        n += 1;
        const attack = ATTACKS.find((a) => String(args.quote_id).startsWith(`lab-${a.id}-`))!;
        return { txHash: `tx${n}`, failure: options.accept ? null : refusal(attack.expect) };
      },
    };
    const instance = createAttackLab({
      client,
      target: TESTNET_LAB,
      signerKey: KEY,
      now: () => new Date(clock.t),
      log: (line) => logs.push(line),
      freshDeposit: () => FRESH,
      minGapMs: 8_000,
      perDay: options.perDay ?? 300,
      ...(options.saved ? { saved: options.saved } : {}),
      onResult: (recent) => saved.push(recent),
    });
    return { instance, sent, saved, logs, clock };
  }

  it("sends the attack as the lab keeper's rescue, and reports the vault's refusal word for word", async () => {
    const { instance, sent, saved } = lab();
    const result = await instance.run("stale-quote");
    expect(result).toEqual({
      id: "stale-quote",
      at: NOW.toISOString(),
      txHash: "tx1",
      refused: true,
      answer: "BAD_QUOTE: it's more than 2 minutes old",
      expected: "BAD_QUOTE: it's more than 2 minutes old",
    });
    expect(sent[0]).toMatchObject({ user: TESTNET_LAB.user, quote_id: `lab-stale-quote-${NOW.getTime()}` });
    expect(saved.at(-1)).toEqual([result]);
    expect(instance.info().recent).toEqual([result]);
  });

  it("allows one attack at a time, at most one every 8 seconds", async () => {
    const { instance, clock } = lab();
    const first = instance.run("pay-itself");
    await expect(instance.run("over-cap")).rejects.toBeInstanceOf(LabBusy);
    await first;
    clock.t += 3_000;
    await expect(instance.run("over-cap")).rejects.toMatchObject({ retryAfterSec: 5 });
    clock.t += 5_000;
    await expect(instance.run("over-cap")).resolves.toMatchObject({ refused: true });
  });

  it("stops at the day's allowance and opens again the next UTC day", async () => {
    const { instance, clock } = lab({ perDay: 2 });
    await instance.run("pay-itself");
    clock.t += 10_000;
    await instance.run("pay-attacker");
    clock.t += 10_000;
    await expect(instance.run("over-cap")).rejects.toMatchObject({ message: expect.stringMatching(/midnight UTC/) });
    clock.t = Date.parse("2026-11-10T00:00:01Z");
    await expect(instance.run("over-cap")).resolves.toMatchObject({ refused: true });
  });

  it("closes if the vault ever accepts an attack, and says so loudly", async () => {
    const { instance, logs, clock } = lab({ accept: true });
    const result = await instance.run("pay-itself");
    expect(result).toMatchObject({ refused: false, answer: "accepted" });
    expect(logs[0]).toMatch(/ACCEPTED/);
    expect(instance.info().open).toBe(false);
    clock.t += 60_000;
    await expect(instance.run("over-cap")).rejects.toBeInstanceOf(LabClosed);
  });

  it("picks up its recent attacks, spacing and lock after a restart", async () => {
    const earlier: AttackResult = { id: "pay-itself", at: new Date(NOW.getTime() - 2_000).toISOString(), txHash: "old", refused: true, answer: "x", expected: "x" };
    const { instance } = lab({ saved: [earlier] });
    expect(instance.info().recent).toEqual([earlier]);
    await expect(instance.run("over-cap")).rejects.toBeInstanceOf(LabBusy);
    const accepted = lab({ saved: [{ ...earlier, at: "2026-11-01T00:00:00Z", refused: false }] });
    expect(accepted.instance.info().open).toBe(false);
  });

  it("frees itself for the next attack when sending fails", async () => {
    const clock = { t: NOW.getTime() };
    const instance = createAttackLab({
      client: {
        view: async () => null,
        call: async () => {
          throw new Error("RPC down");
        },
      },
      target: TESTNET_LAB,
      signerKey: KEY,
      now: () => new Date(clock.t),
      log: () => {},
      freshDeposit: () => FRESH,
    });
    await expect(instance.run("pay-itself")).rejects.toThrow("RPC down");
    clock.t += 9_000;
    await expect(instance.run("pay-itself")).rejects.toThrow("RPC down");
  });
});
