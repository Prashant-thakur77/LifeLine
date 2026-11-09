import { describe, expect, it } from "vitest";
import { checkResponseSignature, fetchSignature, recoverPersonalSigner, sha256Hex, type SignatureResponse } from "../src/signature";
import { testSigner } from "./helpers";

const enc = new TextEncoder();
const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

const request = enc.encode(JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "{}" }] }));
const response = enc.encode(JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { content: "Your reserve topped it up." } }] }));

function signed(overrides: Partial<SignatureResponse> = {}, key = testSigner()): SignatureResponse {
  const text = `${MODEL}:${sha256Hex(request)}:${sha256Hex(response)}`;
  return { text, signature: key.sign(text), signing_address: key.address, signing_algo: "ecdsa", signature_kind: "provider_tee", ...overrides };
}

const check = (signature: SignatureResponse, attestedSigners: readonly string[] = [testSigner().address], bytes = { request, response }) =>
  checkResponseSignature({ signature, model: MODEL, ...bytes, attestedSigners });

describe("recoverPersonalSigner", () => {
  it("recovers the address that signed, with v as 27/28 or 0/1", () => {
    const key = testSigner();
    expect(recoverPersonalSigner("hello", key.sign("hello"))).toBe(key.address);
    expect(recoverPersonalSigner("hello", key.sign("hello", "0"))).toBe(key.address);
  });

  it("recovers the signer of a real NEAR AI Cloud answer, recorded on 2026-11-09", () => {
    // From GET /v1/signature/{id} for a live completion. The address was the one model node
    // in that day's attestation report, which the keeper verifies through Intel and NVIDIA.
    const real = {
      text: "deepseek-ai/DeepSeek-V4.1-Flash-1017:a2eda92b2d07102c39992b932690008e5605c4c28e1bb60972d9fc65e9fb1177:487c0464c86ec1ab05fc49811341643dadcc6c11022f15c10bace3b75a942002",
      signature: "0x7e4f425b8472dac5521976e7319289e568c47e317f5a0356ccbbcb8d7bb04f8e006a0557884edc2f33c5ac88cc6b16bcd20a280d87910fd57239d67477c903b51c",
      signing_address: "0xfe0071895500a9755c18044948ab4f4e1a7f337e"
    };
    expect(recoverPersonalSigner(real.text, real.signature)).toBe(real.signing_address);
  });

  it("gives another address for other text, and null for malformed signatures", () => {
    const key = testSigner();
    expect(recoverPersonalSigner("hello!", key.sign("hello"))).not.toBe(key.address);
    expect(recoverPersonalSigner("hello", "0x1234")).toBeNull();
    expect(recoverPersonalSigner("hello", `0x${"zz".repeat(65)}`)).toBeNull();
    expect(recoverPersonalSigner("hello", `${key.sign("hello").slice(0, -2)}05`)).toBeNull();
  });
});

describe("checkResponseSignature", () => {
  it("verifies an answer signed by an attested model enclave over these exact bytes", () => {
    expect(check(signed())).toEqual({ verified: true, signer: testSigner().address });
  });

  it("accepts the attested address in any letter case", () => {
    expect(check(signed(), [testSigner().address.toUpperCase().replace("0X", "0x")]).verified).toBe(true);
  });

  it("refuses a response whose bytes changed after signing, even by one character", () => {
    const tampered = enc.encode(new TextDecoder().decode(response).replace("topped", "toppd"));
    expect(check(signed(), undefined, { request, response: tampered })).toMatchObject({ verified: false, reason: expect.stringMatching(/different/) });
  });

  it("refuses a signature over another request", () => {
    const other = enc.encode(JSON.stringify({ model: MODEL, messages: [] }));
    expect(check(signed(), undefined, { request: other, response }).verified).toBe(false);
  });

  it("refuses a signer the hardware attestation didn't verify, and names it", () => {
    const stranger = testSigner(3);
    expect(check(signed({}, stranger))).toEqual({ verified: false, reason: expect.stringMatching(/attestation/), signer: stranger.address });
  });

  it("refuses a gateway signature or one with no kind: only the model's own enclave binds the answer to the model", () => {
    expect(check(signed({ signature_kind: "gateway" })).verified).toBe(false);
    expect(check(signed({ signature_kind: undefined })).verified).toBe(false);
  });

  it("refuses other algorithms, and a stated address that isn't the one that signed", () => {
    expect(check(signed({ signing_algo: "ed25519" })).verified).toBe(false);
    expect(check(signed({ signing_address: testSigner(3).address }), [testSigner(3).address]).verified).toBe(false);
  });

  it("refuses incomplete answers from the signature endpoint", () => {
    expect(check({ signature_kind: "provider_tee", signing_algo: "ecdsa" }).verified).toBe(false);
  });
});

describe("fetchSignature", () => {
  const sig = signed();
  const opts = (fetchFn: typeof fetch) => ({
    baseUrl: "https://near-ai.test/v1",
    apiKey: "key",
    chatId: "chatcmpl-1",
    model: MODEL,
    fetch: fetchFn,
    sleep: async () => {},
  });

  it("asks for the ECDSA signature of that answer, with the key, and retries while it's still being recorded", async () => {
    const calls: string[] = [];
    let n = 0;
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push(String(url));
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer key");
      n += 1;
      return n < 3 ? new Response("{}", { status: 404 }) : Response.json(sig);
    }) as typeof fetch;
    expect(await fetchSignature(opts(fetchFn))).toEqual(sig);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe(`https://near-ai.test/v1/signature/chatcmpl-1?model=${encodeURIComponent(MODEL)}&signing_algo=ecdsa`);
  });

  it("gives up after a few tries, on an error status, on an error body, or when unreachable", async () => {
    expect(await fetchSignature(opts((async () => new Response("{}", { status: 404 })) as typeof fetch))).toBeNull();
    expect(await fetchSignature(opts((async () => new Response("{}", { status: 500 })) as typeof fetch))).toBeNull();
    expect(await fetchSignature(opts((async () => Response.json({ error_code: "x", message: "stream disconnected" })) as typeof fetch))).toBeNull();
    expect(
      await fetchSignature(
        opts((async () => {
          throw new Error("down");
        }) as typeof fetch),
      ),
    ).toBeNull();
  });
});
