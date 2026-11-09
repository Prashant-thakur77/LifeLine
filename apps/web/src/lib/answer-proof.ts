import type { AuditRecord } from "@lifeline/shared";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

// Checks a model's words on the ledger from the bytes the keeper kept, in the browser:
// the hashes, the enclave's signature, and then, live, that NEAR AI Cloud's hardware
// report vouches for the signing key, with Intel's signature on that report checked
// here too. Nothing in it relies on the keeper's word.

/** As the keeper serves it from GET /api/proof/:recordId (apps/keeper/src/explain.ts). */
export type AnswerProof = {
  model: string;
  requestBase64: string;
  responseBase64: string;
  signedText: string;
  signature: string;
  signingAddress: string;
  verifiedAt: string;
};
export type ProvedRecord = { record: AuditRecord; proof: AnswerProof };

export const NEAR_AI_URL = "https://cloud-api.near.ai/v1";
/**
 * Intel's collateral (its signed TCB info, identities and revocation lists) through a
 * public mirror, because Intel's own API doesn't allow browser requests. Every item is
 * signed by Intel and checked against Intel's root key, so the mirror can't forge any.
 */
export const PCCS_URL = "https://pccs.phala.network/tdx/certification/v4";
const GOOD_INTEL_STATUSES = new Set(["UpToDate", "OutOfDate"]);
const MAX_MODEL_LENGTH = 400;

export type Step = { name: string; passed: boolean; detail: string };

export const base64ToBytes = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

/** The address that signed `text` with Ethereum's personal-sign (EIP-191), or null. */
export function recoverPersonalSigner(text: string, signatureHex: string): string | null {
  const clean = signatureHex.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{130}$/.test(clean)) return null;
  const raw = hexToBytes(clean);
  const v = raw[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) return null;
  const message = utf8ToBytes(text);
  const digest = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${message.length}`), message));
  try {
    const point = secp256k1.Signature.fromBytes(raw.subarray(0, 64), "compact").addRecoveryBit(recovery).recoverPublicKey(digest);
    return `0x${bytesToHex(keccak_256(point.toBytes(false).subarray(1)).subarray(12))}`;
  } catch {
    return null;
  }
}

/** The keeper's cleanAnswer, so the words on the ledger can be matched to the signed answer. */
export function cleanAnswer(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();
  if (text === "") return null;
  if (text.length <= MAX_MODEL_LENGTH) return text;
  const cut = text.slice(0, MAX_MODEL_LENGTH);
  const lastStop = cut.lastIndexOf(". ");
  return lastStop > 0 ? cut.slice(0, lastStop + 1) : null;
}

export type OfflineCheck = {
  steps: Step[];
  /** What the model was told: only the record's numbers and plain facts. */
  facts: unknown;
  /** The model's words as it signed them. */
  words: string | null;
  signer: string | null;
};

/** Everything the proof shows by itself, with no network at all. */
export function checkProofOffline({ record, proof }: ProvedRecord): OfflineCheck {
  const request = base64ToBytes(proof.requestBase64);
  const response = base64ToBytes(proof.responseBase64);
  const requestHash = bytesToHex(sha256(request));
  const responseHash = bytesToHex(sha256(response));
  const rebuilt = `${proof.model}:${requestHash}:${responseHash}`;

  let facts: unknown = null;
  let sentModel: unknown = null;
  try {
    const sent = JSON.parse(decode(request)) as { model?: unknown; messages?: { content?: unknown }[] };
    sentModel = sent.model;
    facts = JSON.parse(String(sent.messages?.[1]?.content));
  } catch {
    facts = null;
  }
  let words: string | null = null;
  try {
    const answer = JSON.parse(decode(response)) as { choices?: { message?: { content?: unknown } }[] };
    words = cleanAnswer(answer.choices?.[0]?.message?.content);
  } catch {
    words = null;
  }
  const signer = recoverPersonalSigner(proof.signedText, proof.signature);
  const explanation = record.explanation ?? "";

  const steps: Step[] = [
    {
      name: "The kept bytes are the ones that were signed",
      passed: rebuilt === proof.signedText && sentModel === proof.model,
      detail: `SHA-256 of the request ${requestHash.slice(0, 12)}…, of the answer ${responseHash.slice(0, 12)}…`,
    },
    {
      name: "The signature recovers to the stated key",
      passed: signer !== null && signer === proof.signingAddress.toLowerCase(),
      detail: signer === null ? "the signature doesn't recover to any key" : `recovered ${signer}`,
    },
    {
      name: "The words on the ledger are the signed answer",
      passed: words !== null && explanation.endsWith(` ${words}`),
      detail: words === null ? "the signed answer has no words" : "the explanation ends with exactly the signed words",
    },
  ];
  return { steps, facts, words, signer };
}

// ---- Live: is the signing key one NEAR AI's hardware vouches for, right now? ----

type ReportNode = { signing_address?: unknown; request_nonce?: unknown; intel_quote?: unknown };
type Report = { model_attestations?: unknown };

/** Intel's quote verifier, as dcap-qvl's web build exposes it. */
export type IntelVerifier = {
  getCollateral(pccsUrl: string, rawQuote: Uint8Array): Promise<unknown>;
  verify(rawQuote: Uint8Array, collateral: unknown, nowSec: bigint): { status: string; report: { TD10?: { report_data?: string }; TD15?: { base?: { report_data?: string } } } };
};

let intelLoading: Promise<IntelVerifier> | null = null;

/** Loads Intel's verifier (about 1 MB of WebAssembly) only when someone asks for this check. */
export function loadIntel(wasmUrl = "/vendor/dcap-qvl-web_bg.wasm"): Promise<IntelVerifier> {
  intelLoading ??= import("@phala/dcap-qvl-web").then(async (dcap) => {
    await dcap.default({ module_or_path: wasmUrl });
    return {
      getCollateral: (pccsUrl, rawQuote) => dcap.js_get_collateral(pccsUrl, rawQuote) as Promise<unknown>,
      verify: (rawQuote, collateral, nowSec) => dcap.js_verify(rawQuote, collateral, nowSec) as ReturnType<IntelVerifier["verify"]>,
    };
  });
  return intelLoading;
}

export function randomNonce(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

const lowerHex = (value: unknown) => String(value ?? "").toLowerCase().replace(/^0x/, "");

export type LiveCheck = { steps: Step[]; inReport: boolean; nodes: number };

/**
 * Asks NEAR AI Cloud for its attestation report with a nonce made here, finds the signing
 * key, checks Intel's signature on that enclave's quote, and checks the quote vouches for
 * exactly this key and this nonce. A key that isn't in today's report says only that keys
 * have rotated since; the page then shows when the keeper checked it.
 */
export async function checkKeyLive(options: {
  signer: string;
  model: string;
  nonce: string;
  intel: () => Promise<IntelVerifier>;
  now: () => Date;
  fetch?: typeof fetch;
}): Promise<LiveCheck> {
  const { signer, model, nonce } = options;
  const doFetch = options.fetch ?? fetch;
  const url = `${NEAR_AI_URL}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`;
  let report: Report;
  try {
    const response = await doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    report = (await response.json()) as Report;
  } catch (error) {
    return { inReport: false, nodes: 0, steps: [{ name: "NEAR AI Cloud's hardware report", passed: false, detail: `couldn't be fetched (${error instanceof Error ? error.message : "network error"})` }] };
  }
  const nodes = Array.isArray(report.model_attestations) ? (report.model_attestations as ReportNode[]) : [];
  const node = nodes.find((n) => lowerHex(n.signing_address) === lowerHex(signer));
  const listed: Step = {
    name: "NEAR AI Cloud's live report lists this key",
    passed: node !== undefined,
    detail: node === undefined ? `not among today's ${nodes.length} model ${nodes.length === 1 ? "node" : "nodes"}: keys rotate` : `one of ${nodes.length} model ${nodes.length === 1 ? "node" : "nodes"}`,
  };
  if (node === undefined) return { inReport: false, nodes: nodes.length, steps: [listed] };

  const steps: Step[] = [listed];
  const echoed = lowerHex(node.request_nonce) === nonce.toLowerCase();
  steps.push({ name: "The report is fresh: it carries the nonce made here", passed: echoed, detail: echoed ? `nonce ${nonce.slice(0, 12)}…` : "the report is for another nonce" });

  const quoteHex = lowerHex(node.intel_quote);
  if (!/^(?:[0-9a-f]{2})+$/.test(quoteHex)) {
    steps.push({ name: "Intel signed the enclave's quote", passed: false, detail: "the quote isn't hex" });
    return { inReport: true, nodes: nodes.length, steps };
  }
  const raw = hexToBytes(quoteHex);
  let verdict: ReturnType<IntelVerifier["verify"]>;
  try {
    const intel = await options.intel();
    const collateral = await intel.getCollateral(PCCS_URL, raw);
    verdict = intel.verify(raw, collateral, BigInt(Math.floor(options.now().getTime() / 1000)));
  } catch (error) {
    steps.push({ name: "Intel signed the enclave's quote", passed: false, detail: `Intel's check failed here (${error instanceof Error ? error.message : String(error)})` });
    return { inReport: true, nodes: nodes.length, steps };
  }
  steps.push({ name: "Intel signed the enclave's quote", passed: GOOD_INTEL_STATUSES.has(verdict.status), detail: `checked in this browser, Intel status ${verdict.status}` });
  const reportData = lowerHex((verdict.report.TD10 ?? verdict.report.TD15?.base)?.report_data);
  const bound = reportData === lowerHex(signer).padEnd(64, "0") + nonce.toLowerCase();
  steps.push({
    name: "The quote vouches for this key and this nonce",
    passed: bound,
    detail: bound ? "the key and nonce are inside the hardware-signed report data" : "the quote's report data names another key or nonce",
  });
  return { inReport: true, nodes: nodes.length, steps };
}
