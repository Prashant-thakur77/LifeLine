/** The answers a waitlist entry may hold. The dashboard imports these, so its choices and the server's checks can't drift. */
export const ROLES = ["trader", "builder", "agent", "partner"] as const;
export const VENUES = ["hyperliquid", "lighter", "dydx", "gmx", "aster", "drift", "cex", "other"] as const;
export const CHAINS = ["near", "ethereum", "solana", "base", "arbitrum", "bitcoin", "other"] as const;
export const SIZES = ["under-1k", "1k-10k", "10k-100k", "over-100k", "rather-not"] as const;
export const WANTS = ["mainnet", "agents", "more-venues", "alerts", "yield", "sdk"] as const;

export type Role = (typeof ROLES)[number];
export type Venue = (typeof VENUES)[number];
export type Chain = (typeof CHAINS)[number];
export type Size = (typeof SIZES)[number];
export type Want = (typeof WANTS)[number];

export type Entry = {
  name: string;
  email: string;
  role: Role;
  venues: Venue[];
  chains: Chain[];
  size: Size | null;
  liquidated: boolean | null;
  wants: Want[];
  note: string;
};

/** Where a sign-up came from: the `utm_source` of the link, when it's one of these. */
export const SOURCES = ["x", "discord", "hl-discord", "telegram", "reddit", "other", "direct"] as const;
export type Source = (typeof SOURCES)[number];
/** A link's `utm_source` as a source: none is "direct", one we don't know is "other". */
export const sourceOf = (raw: unknown): Source => {
  if (typeof raw !== "string" || raw.trim() === "") return "direct";
  const value = raw.trim().toLowerCase();
  return (SOURCES as readonly string[]).includes(value) ? (value as Source) : "other";
};

/** All the server keeps of someone: how to reach them, what brings them, and which link they came by. */
export type Kept = { email: string; role: Role; source: Source };

/** Which wording of the consent someone agreed to; change it whenever the wording changes. */
export const CONSENT_VERSION = "2026-11-24-minimum";
export const MAX_NAME = 40;
export const MAX_NOTE = 400;
/** How many leading zero bits a sign-up's proof of work needs: under a second in a browser. */
export const POW_BITS = 15;

const EMAIL = /^[^\s@<>"(),;:\\[\]]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export const cleanEmail = (raw: string): string | null => {
  const email = raw.trim().toLowerCase();
  return email.length <= 120 && EMAIL.test(email) ? email : null;
};

// Control characters, and the invisible ones that reorder or hide text.
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** One line of plain text: hidden characters out, spaces collapsed, cut to length. */
export const cleanText = (raw: string, max: number): string =>
  [...raw.replace(HIDDEN, " ").replace(/\s+/g, " ").trim()].slice(0, max).join("");

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => list.includes(value as T);

/** Reads a sign-up, and takes only what we keep. A string is what to tell them is wrong. */
export function parseEntry(body: unknown): Kept | string {
  if (typeof body !== "object" || body === null) return "send an entry";
  const raw = body as Record<string, unknown>;
  const email = typeof raw.email === "string" ? cleanEmail(raw.email) : null;
  if (email === null) return "that email doesn't look right";
  if (!oneOf(ROLES, raw.role)) return "pick what brings you here";
  if (raw.consent !== true) return "we need your yes before we keep your email";
  return { email, role: raw.role, source: sourceOf(raw.source) };
}
