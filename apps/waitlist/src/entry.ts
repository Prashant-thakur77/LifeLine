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

/** Which wording of the consent someone agreed to; change it whenever the wording changes. */
export const CONSENT_VERSION = "2026-11-24";
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

function someOf<T extends string>(list: readonly T[], value: unknown): T[] | null {
  if (!Array.isArray(value) || value.length > list.length) return null;
  return value.every((v) => oneOf(list, v)) ? [...new Set(value as T[])] : null;
}

/** Reads an entry someone sent. A string is what to tell them is wrong. */
export function parseEntry(body: unknown): Entry | string {
  if (typeof body !== "object" || body === null) return "send an entry";
  const raw = body as Record<string, unknown>;
  const name = typeof raw.name === "string" ? cleanText(raw.name, MAX_NAME) : "";
  if (name === "") return "tell us what to call you";
  const email = typeof raw.email === "string" ? cleanEmail(raw.email) : null;
  if (email === null) return "that email doesn't look right";
  if (!oneOf(ROLES, raw.role)) return "pick what brings you here";
  const venues = someOf(VENUES, raw.venues ?? []);
  const chains = someOf(CHAINS, raw.chains ?? []);
  const wants = someOf(WANTS, raw.wants ?? []);
  if (venues === null || chains === null || wants === null) return "one of the choices isn't on the list";
  if (raw.size != null && !oneOf(SIZES, raw.size)) return "one of the choices isn't on the list";
  if (raw.liquidated != null && typeof raw.liquidated !== "boolean") return "one of the choices isn't on the list";
  if (raw.consent !== true) return "we need your yes before we keep your email";
  return {
    name,
    email,
    role: raw.role,
    venues,
    chains,
    size: (raw.size as Size | null | undefined) ?? null,
    liquidated: (raw.liquidated as boolean | null | undefined) ?? null,
    wants,
    note: typeof raw.note === "string" ? cleanText(raw.note, MAX_NOTE) : "",
  };
}
