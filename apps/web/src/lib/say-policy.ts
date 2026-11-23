import type { PolicyDraft } from "./policy";

// Turns rules written the way you'd say them into the policy form. No model is involved:
// each phrase either matches a rule below or is reported as not used, so nothing is guessed.
// The form then checks the result exactly as if it had been typed in.

export type Heard = { field: keyof PolicyDraft; label: string; value: string };
export type Said = { changes: Partial<PolicyDraft>; heard: Heard[]; /** Numbers that no rule claimed. */ unused: string[]; /** Two different values for one rule. */ clashes: string[] };

const LABEL: Record<keyof PolicyDraft, string> = {
  hlAddress: "Pays only",
  warn: "Warn below",
  trigger: "Rescue below",
  target: "Refill to",
  maxPerRescueUsdc: "Most per rescue",
  maxPerDayUsdc: "Most per day",
  cooldownSec: "Wait between rescues",
};

const HEALTH = String.raw`(\d(?:\.\d{1,2})?)(?![\d.]*\d|\s*(?:%|k\b|usdc?|dollars?|bucks?|min|sec|s\b|h\b|hours?))`;
const MONEY = String.raw`\$?\s?(\d[\d,]*(?:\.\d{1,6})?)\s?(k\b)?\s?(?:usdc?|dollars?|bucks?)?`;
const TO = String.raw`(?:\s+(?:me|it|my|the|account|health|margin|position|is|goes|gets|drops|falls|dips|to|at|if|when|once|it's|hits|reaches|back|up|under|below|around|about)){0,7}\s+`;

type Rule = { field: keyof PolicyDraft; pattern: RegExp; read: (m: RegExpExecArray) => string };
const health = (m: RegExpExecArray) => m[1]!;
const money = (m: RegExpExecArray) => String(Number(m[1]!.replaceAll(",", "")) * (m[2] ? 1000 : 1));
const UNIT = { s: 1, m: 60, h: 3600 } as const;
const seconds = (m: RegExpExecArray) => String(Number(m[1]) * UNIT[m[2]![0]!.toLowerCase() as "s" | "m" | "h"]);

const NEGATED = /\b(?:don'?t|do not|never|not|stop)\s+(?:\w+\s+){0,2}$/i;
const HEALTH_FIELDS = new Set<keyof PolicyDraft>(["warn", "trigger", "target"]);

// Order matters: the first rule to claim a stretch of text keeps it.
const RULES: Rule[] = [
  { field: "hlAddress", pattern: /\b(0x[0-9a-f]{40})\b/gi, read: (m) => m[1]! },
  { field: "cooldownSec", pattern: /\b(?:wait|cooldown(?: of)?|pause|at least|leave|gap of)\s+(?:of\s+|for\s+)?(?:at least\s+)?(\d{1,4})\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:ours?|rs?)?)\b/gi, read: seconds },
  { field: "cooldownSec", pattern: /\b(\d{1,4})\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:ours?|rs?)?)\s+(?:between|apart|cooldown)/gi, read: seconds },
  { field: "maxPerDayUsdc", pattern: new RegExp(`${MONEY}\\s*(?:a day|per day|daily|each day|every day|\\/\\s?day|in (?:any )?24 ?h(?:ours)?|per 24 ?h(?:ours)?)`, "gi"), read: money },
  { field: "maxPerDayUsdc", pattern: new RegExp(`\\b(?:daily|per.day|a day)\\s+(?:cap|limit|max(?:imum)?)\\s*(?:of|at|is|:|to)?\\s*${MONEY}`, "gi"), read: money },
  { field: "maxPerRescueUsdc", pattern: new RegExp(`${MONEY}\\s*(?:a time|at a time|at once|per rescue|per top.?up|each(?: time)?|a rescue|a top.?up|\\/\\s?rescue)`, "gi"), read: money },
  { field: "maxPerRescueUsdc", pattern: new RegExp(`\\b(?:per.rescue|rescue|top.?up)\\s+(?:cap|limit|max(?:imum)?)\\s*(?:of|at|is|:|to)?\\s*${MONEY}`, "gi"), read: money },
  { field: "warn", pattern: new RegExp(`\\b(?:warn|alert|tell|ping|notify|message)${TO}${HEALTH}`, "gi"), read: health },
  { field: "target", pattern: new RegExp(`\\b(?:refill|bring|back|restore|raise|lift|target|return)${TO}${HEALTH}`, "gi"), read: health },
  { field: "target", pattern: new RegExp(`\\b(?:up to|to)\\s+(?:a health of\\s+)?${HEALTH}`, "gi"), read: health },
  { field: "trigger", pattern: new RegExp(`\\b(?:rescue|save|top.?up|top me up|step in|act|trigger|help|keep|protect)${TO}(?:above\\s+)?${HEALTH}`, "gi"), read: health },
  { field: "trigger", pattern: new RegExp(`\\b(?:below|under|drops? to|falls? to|hits|above)\\s+(?:a health of\\s+)?${HEALTH}`, "gi"), read: health },
];

export function sayPolicy(text: string): Said {
  // Claimed stretches are blanked so no second rule reads the same number.
  let left = text.slice(0, 600);
  const changes: Partial<PolicyDraft> = {};
  const heard: Heard[] = [];
  const clashes: string[] = [];
  const turnedDown: string[] = [];
  for (const { field, pattern, read } of RULES) {
    for (const match of [...left.matchAll(pattern)]) {
      const value = read(match as unknown as RegExpExecArray);
      const start = match.index;
      const before = left.slice(0, start);
      left = left.slice(0, start) + " ".repeat(match[0].length) + left.slice(start + match[0].length);
      // "Don't rescue me below 1.5" isn't a rule. "Never more than $20 a day" still is.
      if (HEALTH_FIELDS.has(field) && NEGATED.test(before)) {
        turnedDown.push(match[1]!);
        continue;
      }
      const earlier = changes[field];
      if (earlier !== undefined && earlier !== value) {
        if (!clashes.includes(LABEL[field])) clashes.push(LABEL[field]);
        continue;
      }
      if (earlier === undefined) heard.push({ field, label: LABEL[field], value });
      changes[field] = value;
    }
  }
  // A rule said two ways isn't guessed at: neither value is used.
  for (const label of clashes) {
    const item = heard.find((h) => h.label === label)!;
    delete changes[item.field];
    heard.splice(heard.indexOf(item), 1);
  }
  return { changes, heard, unused: [...turnedDown, ...[...left.matchAll(/\$?\d[\d,.]*\w*%?/g)].map((m) => m[0].replace(/[.,]$/, ""))], clashes };
}

export function heardText(item: Heard): string {
  if (item.field === "hlAddress") return `${item.value.slice(0, 6)}…${item.value.slice(-4)}`;
  if (item.field === "cooldownSec") return `${item.value} s`;
  return item.field === "maxPerRescueUsdc" || item.field === "maxPerDayUsdc" ? `${item.value} USDC` : item.value;
}
