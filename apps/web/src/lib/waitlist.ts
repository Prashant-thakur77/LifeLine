import { POW_BITS, ROLES, SIZES, VENUES, CHAINS, WANTS, cleanEmail, cleanText, MAX_NAME, type Chain, type Entry, type Role, type Size, type Venue, type Want } from "@lifeline/waitlist";
import { leadingZeroBits, powDigest } from "@lifeline/waitlist/pow";

// The waitlist conversation: what it asks, what it understands from plain typing, and how it's sent.

export const WAITLIST_URL = (process.env.NEXT_PUBLIC_WAITLIST_URL ?? "").trim().replace(/\/+$/, "") || "https://lifeline-waitlist.prashantthakur.dev";

export type Draft = Omit<Entry, "role"> & { role: Role | null };
export const EMPTY_DRAFT: Draft = { name: "", email: "", role: null, venues: [], chains: [], size: null, liquidated: null, wants: [], note: "" };

export const STEPS = ["name", "story", "role", "venues", "chains", "size", "wants", "email"] as const;
export type Step = (typeof STEPS)[number];

export const ROLE_LABEL: Record<Role, string> = { trader: "I trade perps", builder: "I build things", agent: "I run trading agents", partner: "I want to work with you" };
export const VENUE_LABEL: Record<Venue, string> = { hyperliquid: "Hyperliquid", lighter: "Lighter", dydx: "dYdX", gmx: "GMX", aster: "Aster", drift: "Drift", cex: "A centralised exchange", other: "Somewhere else" };
export const CHAIN_LABEL: Record<Chain, string> = { near: "NEAR", ethereum: "Ethereum", solana: "Solana", base: "Base", arbitrum: "Arbitrum", bitcoin: "Bitcoin", other: "Another chain" };
export const SIZE_LABEL: Record<Size, string> = { "under-1k": "Under $1k", "1k-10k": "$1k to $10k", "10k-100k": "$10k to $100k", "over-100k": "Over $100k", "rather-not": "Rather not say" };
export const WANT_LABEL: Record<Want, string> = {
  mainnet: "Rescues on mainnet for me",
  agents: "Let my AI agent use it",
  "more-venues": "More exchanges",
  alerts: "Just the early warnings",
  yield: "Yield on the idle reserve",
  sdk: "An SDK for my app",
};

const VENUE_WORDS: [Venue, RegExp][] = [
  ["hyperliquid", /\bhyper ?liquid\b|\bhl\b|\bhype\b/i],
  ["lighter", /\blighter\b/i],
  ["dydx", /\bdydx\b/i],
  ["gmx", /\bgmx\b/i],
  ["aster", /\baster\b/i],
  ["drift", /\bon drift\b|\bdrift protocol\b|\bDrift\b/],
  ["cex", /\b(binance|bybit|okx|coinbase|kraken|bitget|cex)\b/i],
];

// "near" and "base" are ordinary words, and ETH or BTC is usually what someone trades rather
// than where their money sits, so each needs a word that makes it a chain.
const CHAIN_WORDS: [Chain, RegExp][] = [
  ["near", /\bNEAR\b|\bon near\b|\bnear (protocol|chain|wallet|intents)\b/],
  ["ethereum", /\bethereum\b|\bon eth\b|\beth mainnet\b/i],
  ["solana", /\bsolana\b|\bon sol\b/i],
  ["base", /\bon base\b|\bBase\b|\bbase chain\b/],
  ["arbitrum", /\barbitrum\b|\bon arb\b/i],
  ["bitcoin", /\bon (bitcoin|btc)\b|\bbtc wallet\b/i],
];

const AMOUNT = /(\$|usd[ct]?\s?)?(\d[\d,]*(?:\.\d+)?)\s*(k|m|thousand|million|mil)?\b(\s?(?:usd[ct]?|dollars|bucks))?/gi;

/** The largest amount of money named, in dollars. A bare number, a year or a leverage isn't one. */
export function largestAmount(text: string): number | null {
  let best: number | null = null;
  for (const [, sign, digits, unit, after] of text.matchAll(AMOUNT)) {
    if (!sign && !unit && !after) continue;
    const scale = unit === undefined ? 1 : /^(m|mil|million)$/i.test(unit) ? 1_000_000 : 1000;
    const value = Number(digits!.replaceAll(",", "")) * scale;
    if (Number.isFinite(value) && (best === null || value > best)) best = value;
  }
  return best;
}

export const sizeOf = (usd: number): Size => (usd < 1000 ? "under-1k" : usd < 10_000 ? "1k-10k" : usd <= 100_000 ? "10k-100k" : "over-100k");

/** Whether they say it happened to them. A fear of it isn't a yes, and a "never" is a no. */
export function wasLiquidated(text: string): boolean | null {
  const said = /\b(?:liquidated|got liq'?d|rekt|blew up|blown up|wiped out)\b/i.exec(text);
  if (said === null) return null;
  const before = text.slice(0, said.index).toLowerCase().split(/[.!?;]/).at(-1)!;
  if (/\b(never|haven'?t|hasn'?t|not been|not yet)\b/.test(before)) return false;
  if (/(want to|afraid|scared|fear|avoid|worr|don'?t|without|before i|if i|might|could)\b/.test(before)) return null;
  return true;
}

export type Understood = Pick<Draft, "venues" | "chains" | "size" | "liquidated" | "role">;

/** What a sentence typed the way you'd talk says about you. Everything it finds can be changed. */
export function understand(text: string): Understood {
  const pick = <T,>(words: [T, RegExp][]) => words.filter(([, re]) => re.test(text)).map(([id]) => id);
  const usd = largestAmount(text);
  const role: Role | null = /\b(partner|invest(or)?|fund|market maker|work with you|collab\w*|hire)\b/i.test(text)
    ? "partner"
    : /\b(agents?|bots?)\b/i.test(text)
      ? "agent"
      : /\b(build(er|ing)?|developer|dev|integrat\w+|sdk|api)\b/i.test(text)
        ? "builder"
        : /\b(trad(e|er|ing)|long(s|ing)?|short(s|ing)?|perps?|leverage|\d+x)\b/i.test(text)
          ? "trader"
          : null;
  return { venues: pick(VENUE_WORDS), chains: pick(CHAIN_WORDS), size: usd === null ? null : sizeOf(usd), liquidated: wasLiquidated(text), role };
}

const merge = <T,>(a: T[], b: T[]) => [...new Set([...a, ...b])];

/** The draft with what the story says added. What was chosen by hand stays. */
export function withStory(draft: Draft): Draft {
  const heard = understand(draft.note);
  return {
    ...draft,
    role: draft.role ?? heard.role,
    venues: merge(draft.venues, heard.venues),
    chains: merge(draft.chains, heard.chains),
    size: draft.size ?? heard.size,
    liquidated: heard.liquidated ?? draft.liquidated,
  };
}

/** Whether the story already answered a question, so it isn't asked again. */
export function answered(step: Step, draft: Draft): boolean {
  if (step === "role") return draft.role !== null;
  if (step === "venues") return draft.venues.length > 0;
  if (step === "chains") return draft.chains.length > 0;
  if (step === "size") return draft.size !== null;
  return false;
}

/** The next question worth asking. Only traders and agents are asked what they trade. */
export function nextStep(from: Step, draft: Draft): Step | null {
  for (const step of STEPS.slice(STEPS.indexOf(from) + 1)) {
    if (answered(step, draft)) continue;
    if ((step === "venues" || step === "size") && (draft.role === "builder" || draft.role === "partner")) continue;
    return step;
  }
  return null;
}

/** Null when the answer will do, otherwise what's missing. */
export function problemWith(step: Step, draft: Draft): string | null {
  if (step === "name" && cleanText(draft.name, MAX_NAME) === "") return "Any name will do, even a made-up one.";
  if (step === "role" && draft.role === null) return "Pick the one that's closest.";
  if (step === "email" && cleanEmail(draft.email) === null) return "That email doesn't look right. It should read like you@example.com.";
  return null;
}

export const toggle = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

export const CHOICES = { role: ROLES, venues: VENUES, chains: CHAINS, size: SIZES, wants: WANTS } as const;

/** Finds a nonce in slices, so the page stays responsive. */
export async function solvePow(challenge: string, bits: number, pause = () => new Promise<void>((r) => setTimeout(r, 0))): Promise<string> {
  if (bits > POW_BITS + 5) throw new Error("the spam check asked for too much work");
  for (let n = 0; ; n += 1) {
    if (leadingZeroBits(powDigest(challenge, String(n))) >= bits) return String(n);
    if (n % 2000 === 1999) await pause();
  }
}

export type Ticket = { berth: string; leaveCode: string };

async function call<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${WAITLIST_URL}${path}`, {
      ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Couldn't reach the waitlist. Check your connection and send it again; your answers are still here.");
  }
  const answer = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || answer === null) {
    const said = answer?.error ?? `the waitlist answered ${response.status}`;
    throw new Error(`${said[0]!.toUpperCase()}${said.slice(1)}.`);
  }
  return answer;
}

export async function joinWaitlist(draft: Draft, website: string): Promise<Ticket> {
  const { challenge, bits } = await call<{ challenge: string; bits: number }>("/api/challenge");
  const nonce = await solvePow(challenge, bits);
  return call<Ticket>("/api/join", { ...draft, website, consent: true, challenge, nonce });
}

export const leaveWaitlist = (email: string, leaveCode: string) => call<{ ok: true }>("/api/leave", { email, leaveCode });

export const shareText = (berth: string) => `I have berth ${berth} on the Lifeline waitlist: automatic margin top-up before liquidation, from a vault that only pays my own address.`;
export const shareHref = (berth: string) =>
  `https://x.com/intent/post?${new URLSearchParams({ text: shareText(berth), url: "https://lifeline.prashantthakur.dev/waitlist" })}`;
