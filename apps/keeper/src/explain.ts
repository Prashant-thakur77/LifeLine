import { describeReason } from "@lifeline/bot";
import { ASSETS, type AuditRecord } from "@lifeline/shared";

const REQUEST_TIMEOUT_MS = 4_000; // Telegram has 10 s, so this can't take all of it
const MAX_TOKENS = 160;
const MAX_LENGTH = 600;

const SYSTEM_PROMPT = [
  "You explain what Lifeline just did to the person whose account it protects. Lifeline tops up a Hyperliquid margin account from their reserve when its health falls too low.",
  "Write 2 or 3 short, plain sentences, using only the facts you are given.",
  "Don't state any number that isn't in the facts, and don't calculate new ones. Don't give advice. No markdown.",
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
  note?: string;
};

const EVENTS: Partial<Record<AuditRecord["kind"], string>> = {
  RESCUE_ALLOWED: "A rescue has started.",
  RESCUE_DONE: "A rescue finished.",
  RESCUE_BLOCKED: "A rescue was refused by the safety rules, and no money moved.",
  RESCUE_FAILED: "A rescue failed.",
};

/** Only numbers and plain facts. No account names, addresses or deposit details leave the keeper. */
export function factsFor(record: AuditRecord): ExplanationFacts {
  const { kind, healthBefore, healthAfter, latencyMs, oneClickStatus, request, decision, explanation } = record;
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
    ...(explanation === undefined ? {} : { note: explanation }),
  };
}

const NUMBER = /\d+(?:\.\d+)?/g;
const withoutProductName = (text: string) => text.replaceAll("1Click", "");

/** True if every number in the text is one of the facts, however it's rounded. */
export function isGrounded(text: string, facts: object): boolean {
  const known = (withoutProductName(JSON.stringify(facts)).match(NUMBER) ?? []).map(Number);
  return (withoutProductName(text).match(NUMBER) ?? []).every((token) => {
    const decimals = token.split(".")[1]?.length ?? 0;
    return known.some((value) => value.toFixed(decimals) === Number(token).toFixed(decimals));
  });
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
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (text === "") return null;
  if (text.length <= MAX_LENGTH) return text;
  const cut = text.slice(0, MAX_LENGTH);
  const lastStop = cut.lastIndexOf(". ");
  return lastStop > 0 ? cut.slice(0, lastStop + 1) : cut;
}

export type Explainer = { explain(record: AuditRecord): Promise<string | undefined> };

/**
 * Plain words for each rescue, block and failure, from a model on NEAR AI Cloud. The
 * words only describe: nothing reads them to decide anything. Any problem falls back
 * to the template, including an answer with a number the record doesn't support.
 */
export function createExplainer(options: {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  log: (line: string) => void;
  fetch?: typeof fetch;
}): Explainer {
  const { baseUrl, apiKey, model, log } = options;
  const doFetch = options.fetch ?? fetch;

  return {
    async explain(record) {
      if (EVENTS[record.kind] === undefined) return undefined;
      const fallback = templateExplanation(record);
      if (apiKey === null) return fallback;

      const facts = factsFor(record);
      try {
        const response = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: MAX_TOKENS,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: JSON.stringify(facts) },
            ],
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          log(`NEAR AI Cloud answered ${response.status}, so a template explanation was used`);
          return fallback;
        }
        const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
        const text = cleanAnswer(body.choices?.[0]?.message?.content);
        if (text === null) return fallback;
        if (!isGrounded(text, facts)) {
          log("NEAR AI Cloud's explanation had a number the record doesn't support, so a template was used");
          return fallback;
        }
        return text;
      } catch {
        log("NEAR AI Cloud couldn't be reached, so a template explanation was used");
        return fallback;
      }
    },
  };
}
