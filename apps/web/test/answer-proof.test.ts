import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { checkKeyLive, checkProofOffline, cleanAnswer, ledgerShows, PCCS_URL, recoverPersonalSigner, type IntelVerifier, type ProvedRecord } from "../src/lib/answer-proof";

/** A real answer: NEAR AI Cloud signed it in the model's enclave on 2026-11-09, and the keeper kept these bytes. */
const real = JSON.parse(readFileSync(new URL("./fixtures/answer-proof.json", import.meta.url), "utf8")) as ProvedRecord;
const SIGNER = "0xfe0071895500a9755c18044948ab4f4e1a7f337e";

const passedAll = (proved: ProvedRecord) => checkProofOffline(proved).steps.every((step) => step.passed);
const reencode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const decodeB64 = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));

describe("checkProofOffline on a real signed answer", () => {
  it("passes every step, and recovers the attested key", () => {
    const check = checkProofOffline(real);
    expect(check.steps.map((s) => [s.name, s.passed])).toEqual([
      ["The kept bytes are the ones that were signed", true],
      ["The signature recovers to the stated key", true],
      ["The model was told this record's facts, and only those", true],
      ["The record's explanation ends with the signed answer", true],
    ]);
    expect(check.signer).toBe(SIGNER);
    expect(real.record.explanation?.endsWith(check.words!)).toBe(true);
  });

  it("shows the model was told only numbers and plain facts, no account", () => {
    const { facts } = checkProofOffline(real);
    expect(facts).toEqual({
      event: "A rescue was refused by the safety rules, and no money moved.",
      healthBefore: 1.45,
      reasons: ["Your cooldown since the last rescue hasn't passed yet."],
    });
    expect(JSON.stringify(facts)).not.toContain("demo.near");
  });

  it("fails if one character of the answer changed after signing", () => {
    const answer = decodeB64(real.proof.responseBase64).replace("cooldown", "cooldowm");
    const check = checkProofOffline({ ...real, proof: { ...real.proof, responseBase64: reencode(answer) } });
    expect(check.steps[0]?.passed).toBe(false);
  });

  it("fails if the request was swapped", () => {
    const request = decodeB64(real.proof.requestBase64).replace("1.45", "1.46");
    expect(checkProofOffline({ ...real, proof: { ...real.proof, requestBase64: reencode(request) } }).steps[0]?.passed).toBe(false);
  });

  it("fails if the record's words aren't the signed ones", () => {
    const check = checkProofOffline({ ...real, record: { ...real.record, explanation: `${real.record.explanation} And it's all fine.` } });
    expect(check.steps[3]?.passed).toBe(false);
  });

  it("fails a genuine proof served for a different record than the one asked about", () => {
    expect(checkProofOffline(real, real.record.id).steps[0]).toMatchObject({ name: "It's the record you asked about", passed: true });
    expect(checkProofOffline(real, "some-other-record").steps[0]?.passed).toBe(false);
  });

  it("fails a genuine answer attached to a record with other facts", () => {
    const moved = { ...real, record: { ...real.record, healthBefore: 1.2 } };
    expect(checkProofOffline(moved).steps[2]?.passed).toBe(false);
  });

  it("fails, rather than throws, on a proof that isn't even base64", () => {
    const junk = { ...real, proof: { ...real.proof, requestBase64: "%%%", responseBase64: "%%%" } };
    expect(passedAll(junk)).toBe(false);
  });

  it("fails a signature from another key, or one claiming another key", () => {
    const other = secp256k1.utils.randomSecretKey();
    const digest = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${real.proof.signedText.length}`), utf8ToBytes(real.proof.signedText)));
    const sig = secp256k1.sign(digest, other, { prehash: false, format: "recovered" });
    const forged = `0x${bytesToHex(sig.subarray(1))}${(sig[0]! + 27).toString(16)}`;
    expect(passedAll({ ...real, proof: { ...real.proof, signature: forged } })).toBe(false);
    expect(passedAll({ ...real, proof: { ...real.proof, signingAddress: "0x0000000000000000000000000000000000000001" } })).toBe(false);
  });
});

describe("ledgerShows", () => {
  it("passes only when the public ledger has the same words for that record", () => {
    expect(ledgerShows([real.record], real).passed).toBe(true);
    expect(ledgerShows([{ ...real.record, explanation: "Other words." }], real).passed).toBe(false);
    expect(ledgerShows([], real).passed).toBe(false);
  });
});

describe("recoverPersonalSigner", () => {
  it("recovers a real NEAR AI Cloud signature, as the keeper does", () => {
    expect(recoverPersonalSigner(real.proof.signedText, real.proof.signature)).toBe(SIGNER);
    expect(recoverPersonalSigner(`${real.proof.signedText}x`, real.proof.signature)).not.toBe(SIGNER);
    expect(recoverPersonalSigner("x", "0x12")).toBeNull();
  });
});

describe("cleanAnswer", () => {
  it("matches the keeper's: drops thinking, trims, cuts long answers at a sentence", () => {
    expect(cleanAnswer("<think>hmm</think> Done. ")).toBe("Done.");
    expect(cleanAnswer("<think>never closed")).toBeNull();
    expect(cleanAnswer(`${"a".repeat(390)}. ${"b".repeat(50)}`)).toBe(`${"a".repeat(390)}.`);
    expect(cleanAnswer("x".repeat(401))).toBeNull();
    expect(cleanAnswer(7)).toBeNull();
  });
});

describe("checkKeyLive", () => {
  const nonce = "ab".repeat(32);
  const reportData = (address: string, n: string) => address.slice(2).padEnd(64, "0") + n;
  const intel = (status = "UpToDate", data = reportData(SIGNER, nonce), seen: string[] = []): (() => Promise<IntelVerifier>) =>
    async () => ({
      async getCollateral(pccsUrl) {
        seen.push(pccsUrl);
        return { collateral: true };
      },
      verify: () => ({ status, report: { TD10: { report_data: data } } }),
    });
  const report = (nodes: object[]) => (async () => Response.json({ model_attestations: nodes })) as unknown as typeof fetch;
  const node = { signing_address: SIGNER, request_nonce: nonce, intel_quote: "0400aabb" };
  const run = (fetchFn: typeof fetch, verifier = intel()) =>
    checkKeyLive({ signer: SIGNER, model: "m", nonce, intel: verifier, now: () => new Date("2026-11-09T09:30:00Z"), fetch: fetchFn });

  it("passes a key in the live report, with this nonce, Intel's signature, and the key bound in the quote", async () => {
    const seen: string[] = [];
    const live = await run(report([node]), intel("UpToDate", reportData(SIGNER, nonce), seen));
    expect(live.outcome).toBe("proven");
    expect(live.steps.map((s) => s.passed)).toEqual([true, true, true, true]);
    expect(seen).toEqual([PCCS_URL]);
  });

  it("asks NEAR AI Cloud for the report with the nonce made here", async () => {
    let asked = "";
    const fetchFn = (async (url: string) => {
      asked = url;
      return Response.json({ model_attestations: [node] });
    }) as unknown as typeof fetch;
    await run(fetchFn);
    expect(asked).toBe(`https://cloud-api.near.ai/v1/attestation/report?model=m&signing_algo=ecdsa&nonce=${nonce}`);
  });

  it("says a key that isn't in today's report has rotated out, and stops there", async () => {
    const live = await run(report([{ ...node, signing_address: "0x1111111111111111111111111111111111111111" }]));
    expect(live.outcome).toBe("rotated");
    expect(live.steps).toHaveLength(1);
    expect(live.steps[0]?.detail).toMatch(/rotate/);
  });

  it("fails a stale report, a quote Intel won't vouch for, or a quote for another key", async () => {
    const stale = await run(report([{ ...node, request_nonce: "cd".repeat(32) }]));
    expect([stale.outcome, stale.steps[1]?.passed]).toEqual(["failed", false]);
    expect((await run(report([node]), intel("Revoked"))).outcome).toBe("failed");
    const otherKey = await run(report([node]), intel("UpToDate", reportData("0x2222222222222222222222222222222222222222", nonce)));
    expect([otherKey.outcome, otherKey.steps[3]?.passed]).toEqual(["failed", false]);
    const rejected = async (): Promise<IntelVerifier> => ({
      getCollateral: async () => ({}),
      verify: () => {
        throw new Error("bad signature");
      },
    });
    expect((await run(report([node]), rejected)).outcome).toBe("failed");
  });

  it("calls an outage unavailable, not failed: NEAR AI down, an empty report, or Intel's certificates out of reach", async () => {
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const unreachable = await run(down);
    expect(unreachable.outcome).toBe("unavailable");
    expect(unreachable.steps[0]).toMatchObject({ unavailable: true, detail: expect.stringMatching(/503/) });
    const nothing = (async () => Response.json(null)) as unknown as typeof fetch;
    expect((await run(nothing)).outcome).toBe("unavailable");
    const broken = async (): Promise<IntelVerifier> => ({
      getCollateral: async () => {
        throw new Error("collateral unavailable");
      },
      verify: () => ({ status: "UpToDate", report: {} }),
    });
    const noIntel = await run(report([node]), broken);
    expect(noIntel.outcome).toBe("unavailable");
    expect(noIntel.steps[2]).toMatchObject({ unavailable: true, detail: expect.stringMatching(/collateral unavailable/) });
  });
});
