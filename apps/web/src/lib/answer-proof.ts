import type { AuditRecord } from "@lifeline/shared";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { factsFor } from "./facts";

// Checks a model's words on the ledger from the bytes the keeper kept, in the browser:
// the hashes, the enclave's signature, that the words and the facts the model was told
// belong to the record the ledger shows, and then, live, that NEAR AI Cloud's hardware
// report vouches for the signing key, with Intel's signature on that report checked here
// too. The keeper supplies the bytes; it can't make them pass. What it could still do is
// show nothing at all, or a record with no model words.

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
 * signed by Intel and checked against Intel's root key, so the mirror can't forge any,
 * though it could serve an older item that is still within its validity period.
 */
export const PCCS_URL = "https://pccs.phala.network/tdx/certification/v4";
const GOOD_INTEL_STATUSES = new Set(["UpToDate", "OutOfDate"]);
const MAX_MODEL_LENGTH = 400;

/** `unavailable`: the check couldn't be run (a service didn't answer), which proves nothing either way. */
export type Step = { name: string; passed: boolean; detail: string; unavailable?: boolean };

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

const bytesOrEmpty = (text: unknown) => {
  try {
    return base64ToBytes(String(text));
  } catch {
    return new Uint8Array();
  }
};

/**
 * Everything the proof shows by itself, with no network at all. `askedFor` is the record
 * id the page asked about, so a proof for some other record can't stand in for it.
 */
export function checkProofOffline({ record, proof }: ProvedRecord, askedFor?: string): OfflineCheck {
  const request = bytesOrEmpty(proof.requestBase64);
  const response = bytesOrEmpty(proof.responseBase64);
  const requestHash = bytesToHex(sha256(request));
  const responseHash = bytesToHex(sha256(response));
  const rebuilt = `${proof.model}:${requestHash}:${responseHash}`;

  let facts: unknown = null;
  let factsText: string | null = null;
  let sentModel: unknown = null;
  try {
    const sent = JSON.parse(decode(request)) as { model?: unknown; messages?: { content?: unknown }[] };
    sentModel = sent.model;
    factsText = String(sent.messages?.[1]?.content);
    facts = JSON.parse(factsText);
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
  const signer = recoverPersonalSigner(String(proof.signedText), String(proof.signature));
  const explanation = record.explanation ?? "";
  const recordFacts = JSON.stringify(factsFor(record));

  const steps: Step[] = [];
  if (askedFor !== undefined) {
    steps.push({ name: "It's the record you asked about", passed: record.id === askedFor, detail: `record ${record.id}` });
  }
  steps.push(
    {
      name: "The kept bytes are the ones that were signed",
      passed: rebuilt === proof.signedText && sentModel === proof.model,
      detail: `SHA-256 of the request ${requestHash.slice(0, 12)}…, of the answer ${responseHash.slice(0, 12)}…`,
    },
    {
      name: "The signature recovers to the stated key",
      passed: signer !== null && signer === String(proof.signingAddress).toLowerCase(),
      detail: signer === null ? "the signature doesn't recover to any key" : `recovered ${signer}`,
    },
    {
      name: "The model was told this record's facts, and only those",
      passed: factsText === recordFacts,
      detail: factsText === recordFacts ? "rebuilt here from the record, character for character" : "the facts sent don't match this record",
    },
    {
      name: "The record's explanation ends with the signed answer",
      passed: words !== null && explanation.endsWith(` ${words}`),
      detail: words === null ? "the signed answer has no words" : "the explanation ends with exactly the signed words",
    },
  );
  return { steps, facts, words, signer };
}

/** The ledger shows the same words for that record as the proof does, so the proof can't be for words nobody sees. */
export function ledgerShows(ledger: readonly AuditRecord[], proved: ProvedRecord): Step {
  const shown = ledger.find((r) => r.id === proved.record.id);
  if (shown === undefined) return { name: "The ledger shows the same words", passed: false, detail: "this record isn't in the account's latest records" };
  const same = shown.explanation === proved.record.explanation;
  return { name: "The ledger shows the same words", passed: same, detail: same ? "the public ledger has this exact explanation" : "the ledger shows other words for this record" };
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

/** Loads Intel's verifier (about 1 MB of WebAssembly) only when someone asks for this check; a failed load is tried again next time. */
export function loadIntel(wasmUrl = "/vendor/dcap-qvl-web_bg.wasm"): Promise<IntelVerifier> {
  intelLoading ??= import("@phala/dcap-qvl-web")
    .then(async (dcap) => {
      await dcap.default({ module_or_path: wasmUrl });
      return {
        getCollateral: (pccsUrl: string, rawQuote: Uint8Array) => dcap.js_get_collateral(pccsUrl, rawQuote) as Promise<unknown>,
        verify: (rawQuote: Uint8Array, collateral: unknown, nowSec: bigint) => dcap.js_verify(rawQuote, collateral, nowSec) as ReturnType<IntelVerifier["verify"]>,
      };
    })
    .catch((error: unknown) => {
      intelLoading = null;
      throw error;
    });
  return intelLoading;
}

export function randomNonce(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

const lowerHex = (value: unknown) => String(value ?? "").toLowerCase().replace(/^0x/, "");

/**
 * proven: every step passed. rotated: the key isn't in today's report. unavailable: a
 * service didn't answer, which says nothing about the key. failed: a step failed.
 */
export type LiveCheck = { steps: Step[]; outcome: "proven" | "rotated" | "unavailable" | "failed"; nodes: number };

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
  const unavailable = (name: string, detail: string, earlier: Step[] = [], nodes = 0): LiveCheck => ({
    outcome: "unavailable",
    nodes,
    steps: [...earlier, { name, passed: false, unavailable: true, detail }],
  });
  let report: Report | null;
  try {
    const response = await doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    report = (await response.json()) as Report | null;
  } catch (error) {
    return unavailable("NEAR AI Cloud's hardware report", `couldn't be fetched (${error instanceof Error ? error.message : "network error"})`);
  }
  const nodes = Array.isArray(report?.model_attestations) ? (report.model_attestations as ReportNode[]) : [];
  if (nodes.length === 0) return unavailable("NEAR AI Cloud's hardware report", "it listed no model nodes");
  const node = nodes.find((n) => lowerHex(n.signing_address) === lowerHex(signer));
  const listed: Step = {
    name: "NEAR AI Cloud's live report lists this key",
    passed: node !== undefined,
    detail: node === undefined ? `not among today's ${nodes.length} model ${nodes.length === 1 ? "node" : "nodes"}: keys rotate` : `one of ${nodes.length} model ${nodes.length === 1 ? "node" : "nodes"}`,
  };
  if (node === undefined) return { outcome: "rotated", nodes: nodes.length, steps: [listed] };

  const steps: Step[] = [listed];
  const echoed = lowerHex(node.request_nonce) === nonce.toLowerCase();
  steps.push({ name: "The report is fresh: it carries the nonce made here", passed: echoed, detail: echoed ? `nonce ${nonce.slice(0, 12)}…` : "the report is for another nonce" });

  const failed = (): LiveCheck => ({ outcome: "failed", nodes: nodes.length, steps });
  const quoteHex = lowerHex(node.intel_quote);
  if (!/^(?:[0-9a-f]{2})+$/.test(quoteHex)) {
    steps.push({ name: "Intel signed the enclave's quote", passed: false, detail: "the quote isn't hex" });
    return failed();
  }
  const raw = hexToBytes(quoteHex);
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let intel: IntelVerifier;
  let collateral: unknown;
  try {
    intel = await options.intel();
    collateral = await intel.getCollateral(PCCS_URL, raw);
  } catch (error) {
    // Intel's verifier or certificates didn't load: an outage, not evidence about the quote.
    return unavailable("Intel signed the enclave's quote", `Intel's certificates couldn't be fetched here (${errorText(error)})`, steps, nodes.length);
  }
  let verdict: ReturnType<IntelVerifier["verify"]>;
  try {
    verdict = intel.verify(raw, collateral, BigInt(Math.floor(options.now().getTime() / 1000)));
  } catch (error) {
    steps.push({ name: "Intel signed the enclave's quote", passed: false, detail: `Intel's verifier rejected it (${errorText(error)})` });
    return failed();
  }
  const statusNote = verdict.status === "OutOfDate" ? " (genuine, but the platform's security updates lag behind Intel's latest)" : "";
  steps.push({ name: "Intel signed the enclave's quote", passed: GOOD_INTEL_STATUSES.has(verdict.status), detail: `checked in this browser, Intel status ${verdict.status}${statusNote}` });
  const reportData = lowerHex((verdict.report.TD10 ?? verdict.report.TD15?.base)?.report_data);
  const bound = reportData === lowerHex(signer).padEnd(64, "0") + nonce.toLowerCase();
  steps.push({
    name: "The quote vouches for this key and this nonce",
    passed: bound,
    detail: bound ? "the key and nonce are inside the hardware-signed report data" : "the quote's report data names another key or nonce",
  });
  return { outcome: steps.every((step) => step.passed) ? "proven" : "failed", nodes: nodes.length, steps };
}
