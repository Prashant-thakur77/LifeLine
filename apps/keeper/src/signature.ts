import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * NEAR AI Cloud signs each answer inside the model's secure enclave. This checks one
 * signature the way its docs describe for a model-enclave ("provider_tee") signature:
 * the signed text names the model and the SHA-256 of the exact request and response
 * bytes, it recovers (Ethereum personal-sign) to the stated key, and that key is one the
 * hardware attestation verified. Anything else, including a gateway signature, is
 * unverified: only the model's own enclave binds an answer to the model.
 */

export type SignatureResponse = {
  text?: unknown;
  signature?: unknown;
  signing_address?: unknown;
  signing_algo?: unknown;
  signature_kind?: unknown;
  error_code?: unknown;
};

export type SignatureVerdict = { verified: true; signer: string } | { verified: false; reason: string; signer?: string };

const SIGNATURE_TRIES = 4;
const SIGNATURE_RETRY_MS = 750;
/** All tries together: with the 4 s answer, a Telegram alert still goes out within 10 s. */
const SIGNATURE_BUDGET_MS = 4_000;

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const lower = (value: string) => value.toLowerCase();

/** The address that signed `text` with Ethereum's personal-sign (EIP-191), or null if it isn't such a signature. */
export function recoverPersonalSigner(text: string, signatureHex: string): string | null {
  const clean = signatureHex.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{130}$/.test(clean)) return null;
  const raw = Buffer.from(clean, "hex");
  const v = raw[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) return null;
  const message = Buffer.from(text, "utf8");
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`, "utf8"), message]));
  try {
    const point = secp256k1.Signature.fromBytes(raw.subarray(0, 64), "compact").addRecoveryBit(recovery).recoverPublicKey(digest);
    return `0x${Buffer.from(keccak_256(point.toBytes(false).subarray(1))).subarray(12).toString("hex")}`;
  } catch {
    return null;
  }
}

export function checkResponseSignature(input: {
  signature: SignatureResponse;
  model: string;
  request: Uint8Array;
  response: Uint8Array;
  attestedSigners: readonly string[];
}): SignatureVerdict {
  const { signature: s } = input;
  const no = (reason: string): SignatureVerdict => ({ verified: false, reason });
  if (s.signature_kind !== "provider_tee") return no("it wasn't signed by the model's own enclave");
  if (s.signing_algo !== "ecdsa") return no("it uses an unexpected signing algorithm");
  if (typeof s.text !== "string" || typeof s.signature !== "string" || typeof s.signing_address !== "string") {
    return no("the signature response is incomplete");
  }
  const expected = `${input.model}:${sha256Hex(input.request)}:${sha256Hex(input.response)}`;
  if (s.text !== expected) return no("it covers different request or response bytes");
  const signer = recoverPersonalSigner(s.text, s.signature);
  if (signer === null || signer !== lower(s.signing_address)) return no("the signature doesn't recover to the stated key");
  if (!input.attestedSigners.map(lower).includes(signer)) {
    return { verified: false, reason: "its key isn't one the hardware attestation verified", signer };
  }
  return { verified: true, signer };
}

/**
 * GET /v1/signature/{id}. A signature can take a moment to be recorded, so a 404 is
 * retried a few times; anything else that isn't a signature is null.
 */
export async function fetchSignature(options: {
  baseUrl: string;
  apiKey: string;
  chatId: string;
  model: string;
  fetch?: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}): Promise<SignatureResponse | null> {
  const { baseUrl, apiKey, chatId, model, sleep } = options;
  const doFetch = options.fetch ?? fetch;
  const url = `${baseUrl}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
  const deadline = Date.now() + SIGNATURE_BUDGET_MS;
  for (let attempt = 1; attempt <= SIGNATURE_TRIES; attempt += 1) {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(left),
      });
    } catch {
      return null;
    }
    if (response.status === 404 && attempt < SIGNATURE_TRIES) {
      await sleep(SIGNATURE_RETRY_MS);
      continue;
    }
    if (!response.ok) return null;
    try {
      const body = (await response.json()) as SignatureResponse | null;
      // A 2xx can still say the signature is unavailable, such as after a dropped stream.
      if (body === null || typeof body !== "object" || body.error_code !== undefined) return null;
      return body;
    } catch {
      return null;
    }
  }
  return null;
}
