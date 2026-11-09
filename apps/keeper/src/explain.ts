import { describeReason } from "@lifeline/bot";
import { ASSETS, type AuditRecord } from "@lifeline/shared";
import { checkResponseSignature, fetchSignature } from "./signature";

const REQUEST_TIMEOUT_MS = 4_000; // Telegram has 10 s, so this can't take all of it
const MAX_TOKENS = 160;
const MAX_MODEL_LENGTH = 400;

const SYSTEM_PROMPT = [
  "You explain what Lifeline just did to the person whose account it protects. Lifeline tops up a Hyperliquid margin account from their reserve when its health falls too low.",
  "The exact figures are already shown just before your words, so never write digits or repeat a figure.",
  "In 1 or 2 short, plain sentences, say what happened and why, using only the facts you are given. Don't give advice. No links. No markdown.",
].join(" ");

export type ExplanationFacts = {
  event: string;
  healthBefore?: number;
  healthAfter?: number;
  amountUsdc?: number;
  expectedToDeliverUsd?: number;
  seconds?: number;
  oneClickStatus?: string;
  coins?: string[];
  reasons?: string[];
};

const EVENTS: Partial<Record<AuditRecord["kind"], string>> = {
  RESCUE_ALLOWED: "A rescue has started.",
  RESCUE_DONE: "A rescue finished.",
  RESCUE_BLOCKED: "A rescue was refused by the safety rules, and no money moved.",
  RESCUE_FAILED: "A rescue failed.",
};

/** Only numbers and plain facts. No account names, addresses, deposit details or chain errors leave the keeper. */
export function factsFor(record: AuditRecord): ExplanationFacts {
  const { kind, healthBefore, healthAfter, latencyMs, oneClickStatus, request, decision } = record;
  const coins = request?.snapshot.positions.map((position) => position.coin);
  return {
    event: EVENTS[kind] ?? kind,
    ...(healthBefore === undefined ? {} : { healthBefore }),
    ...(healthAfter === undefined ? {} : { healthAfter }),
    ...(request === undefined
      ? {}
      : {
          amountUsdc: Number(request.amount) / 10 ** ASSETS.NEAR_USDC.decimals,
          expectedToDeliverUsd: request.usdNeeded,
        }),
    ...(latencyMs === undefined ? {} : { seconds: Math.round(latencyMs / 1000) }),
    ...(oneClickStatus === undefined ? {} : { oneClickStatus }),
    ...(coins === undefined || coins.length === 0 ? {} : { coins }),
    ...(decision === undefined || decision.reasons.length === 0 ? {} : { reasons: decision.reasons.map(describeReason) }),
  };
}

const NEGATED = /\b(?:no|not|never|nothing|none|without|didn't|did not|wasn't|was not|weren't|hasn't|has not)\b[^.,;]*/gi;
const CLAIMS_SUCCESS = /\b(?:succeed(?:ed|s)?|success(?:ful(?:ly)?)?|completed?|finished|restored|rescued|saved|safe|arrived|delivered)\b/i;
const CLAIMS_MONEY_MOVED = /\b(?:moved|sent|transferred|topped up|credited|deposited)\b/i;
const CLAIMS_FAILURE = /\b(?:fail(?:ed|ure|s)?|blocked|refused|rejected|liquidated)\b/i;
const CLAIMS_FINISHED = /\b(?:completed?|finished|arrived|delivered|restored)\b/i;

const CONTRADICTIONS: Partial<Record<AuditRecord["kind"], RegExp[]>> = {
  RESCUE_ALLOWED: [CLAIMS_FAILURE, CLAIMS_FINISHED],
  RESCUE_DONE: [CLAIMS_FAILURE],
  RESCUE_BLOCKED: [CLAIMS_SUCCESS, CLAIMS_MONEY_MOVED],
  RESCUE_FAILED: [CLAIMS_SUCCESS, CLAIMS_MONEY_MOVED],
};

const HAS_DIGIT = /\d/;
const HAS_LINK = /https?:|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b/i;

/**
 * The record's facts go first and come from the record, so a figure on the ledger can't
 * be wrong. The model only adds words after them, so it may not state figures or links,
 * or claim something happened that didn't.
 */
function isAcceptable(words: string, kind: AuditRecord["kind"]): boolean {
  if (HAS_DIGIT.test(words.replaceAll("1Click", "")) || HAS_LINK.test(words)) return false;
  const asserted = words.replace(NEGATED, "");
  return !(CONTRADICTIONS[kind] ?? []).some((claim) => claim.test(asserted));
}

/** What every record gets if the model can't help: true, and built only from the record. */
export function templateExplanation(record: AuditRecord): string {
  const { kind, healthBefore, healthAfter, latencyMs, oneClickStatus, request, decision, explanation } = record;
  const before = healthBefore === undefined ? "" : ` at health ${healthBefore.toFixed(2)}`;
  const amount = request === undefined ? "" : `${(Number(request.amount) / 10 ** ASSETS.NEAR_USDC.decimals).toFixed(2)} USDC `;
  const parts: string[] = [];

  switch (kind) {
    case "RESCUE_ALLOWED":
      parts.push(`Your account fell below your trigger${before}, so Lifeline is sending ${amount}from your reserve to your Hyperliquid margin.`);
      break;
    case "RESCUE_DONE":
      parts.push(`Lifeline moved ${amount}from your reserve to your Hyperliquid margin.`);
      if (healthBefore !== undefined && healthAfter !== undefined) {
        parts.push(`Your health went from ${healthBefore.toFixed(2)} to ${healthAfter.toFixed(2)}.`);
      }
      if (latencyMs !== undefined) parts.push(`It took ${Math.round(latencyMs / 1000)} seconds.`);
      break;
    case "RESCUE_BLOCKED":
      parts.push(`Lifeline's safety rules refused a rescue${before}, so no money moved.`);
      parts.push(...(decision?.reasons ?? []).map(describeReason));
      break;
    case "RESCUE_FAILED":
      parts.push(`A rescue${before} didn't complete${oneClickStatus ? ` (1Click status: ${oneClickStatus})` : ""}.`);
      break;
    default:
      break;
  }
  if (explanation) parts.push(explanation);
  return parts.join(" ");
}

function cleanAnswer(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Reasoning a model thinks out loud, including when it never closes the tag.
  const text = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();
  if (text === "") return null;
  if (text.length <= MAX_MODEL_LENGTH) return text;
  const cut = text.slice(0, MAX_MODEL_LENGTH);
  const lastStop = cut.lastIndexOf(". ");
  return lastStop > 0 ? cut.slice(0, lastStop + 1) : null;
}

/**
 * What anyone needs to check a kept answer without trusting the keeper: the exact bytes
 * sent to NEAR AI Cloud and received from it, and the enclave's signature over their
 * hashes. Recompute both SHA-256 hashes, rebuild the signed text, recover the signer.
 */
export type AnswerProof = {
  model: string;
  /** The request body as sent, base64, so its hash can be recomputed byte for byte. */
  requestBase64: string;
  /** The response body as received (after decompression), base64. */
  responseBase64: string;
  /** `model:sha256(request):sha256(response)`, as NEAR AI Cloud signed it. */
  signedText: string;
  /** Ethereum personal-sign (EIP-191) signature over signedText. */
  signature: string;
  signingAddress: string;
  /** When the keeper checked it against the keys its hardware attestation verified. */
  verifiedAt: string;
};

/** The words for a record, and the proof behind the model's part of them when there is one. */
export type Explained = { text: string; proof?: AnswerProof };

export type Explainer = {
  explain(record: AuditRecord): Promise<string | undefined>;
  explainWithProof(record: AuditRecord): Promise<Explained | undefined>;
};

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/**
 * Plain words for each rescue, block and failure: the record's own facts, then a model's
 * words from NEAR AI Cloud. Nothing reads them to decide anything. Any problem leaves
 * just the facts, including words that contradict the record.
 *
 * The model's words are kept only when NEAR AI Cloud's signature over this exact
 * exchange verifies against a key the hardware attestation vouched for (signature.ts),
 * so an unverified answer never reaches the log.
 */
export function createExplainer(options: {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  log: (line: string) => void;
  /** The signing keys the latest verified attestation names. */
  signers: () => readonly string[];
  /** Called when an answer is signed by a key the attestation didn't name, so it can be checked again. */
  onUnknownSigner?: () => void;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => Date;
}): Explainer {
  const { baseUrl, apiKey, model, log, signers, onUnknownSigner } = options;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());

  const explainWithProof = async (record: AuditRecord): Promise<Explained | undefined> => {
    if (EVENTS[record.kind] === undefined) return undefined;
    const text = templateExplanation(record);
    const fallback: Explained = { text };
    if (apiKey === null) return fallback;

    const facts = factsFor(record);
    try {
      // Sent and hashed as these exact bytes: the signature covers them.
      const requestBody = JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: MAX_TOKENS,
        // The model reasons before answering by default, and that thinking counts against
        // max_tokens: it ran out mid-answer or before answering at all. One plain sentence
        // needs no reasoning.
        reasoning_effort: "none",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(facts) },
        ],
      });
      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        // No aliasing, so the model's own enclave signs the answer rather than the gateway.
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "x-no-aliasing": "true" },
        body: requestBody,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        log(`NEAR AI Cloud answered ${response.status}, so a template explanation was used`);
        return fallback;
      }
      const responseBytes = new Uint8Array(await response.arrayBuffer());
      const body = JSON.parse(new TextDecoder().decode(responseBytes)) as {
        id?: unknown;
        choices?: { finish_reason?: unknown; message?: { content?: unknown } }[];
      };
      const choice = body.choices?.[0];
      // Cut off by the token limit, so it stops mid-sentence.
      if (choice?.finish_reason === "length") return fallback;
      const words = cleanAnswer(choice?.message?.content);
      if (words === null) return fallback;
      if (!isAcceptable(words, record.kind)) {
        log("NEAR AI Cloud's words broke the explanation rules, so only the record's facts were used");
        return fallback;
      }
      if (typeof body.id !== "string") {
        log("NEAR AI Cloud's answer had no id to fetch its signature by, so only the record's facts were used");
        return fallback;
      }
      const signature = await fetchSignature({ baseUrl, apiKey, chatId: body.id, model, fetch: doFetch, sleep });
      if (signature === null) {
        log("NEAR AI Cloud's signature for the answer wasn't available, so only the record's facts were used");
        return fallback;
      }
      const requestBytes = new TextEncoder().encode(requestBody);
      const verdict = checkResponseSignature({ signature, model, request: requestBytes, response: responseBytes, attestedSigners: signers() });
      if (!verdict.verified) {
        log(`NEAR AI Cloud's answer didn't verify (${verdict.reason}), so only the record's facts were used`);
        if (verdict.signer !== undefined) onUnknownSigner?.();
        return fallback;
      }
      return {
        text: `${text} ${words}`,
        proof: {
          model,
          requestBase64: base64(requestBytes),
          responseBase64: base64(responseBytes),
          signedText: String(signature.text),
          signature: String(signature.signature),
          signingAddress: verdict.signer,
          verifiedAt: now().toISOString(),
        },
      };
    } catch {
      log("NEAR AI Cloud couldn't be reached, so a template explanation was used");
      return fallback;
    }
  };

  return {
    explainWithProof,
    async explain(record) {
      return (await explainWithProof(record))?.text;
    },
  };
}
