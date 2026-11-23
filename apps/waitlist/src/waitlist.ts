import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { CONSENT_VERSION, POW_BITS, cleanEmail, parseEntry, type Entry } from "./entry";
import { CHALLENGE_TTL_MS, checkPow, issueChallenge } from "./pow";

type SqlValue = string | number | null;
/** The two calls a Durable Object's storage gives us. */
export type WaitlistStorage = {
  sql: { exec(query: string, ...bindings: SqlValue[]): { toArray(): unknown[] } };
  transactionSync<T>(work: () => T): T;
};

export type WaitlistDeps = {
  storage: WaitlistStorage;
  allowedOrigins: string[];
  adminToken: string | null;
  now?: () => Date;
  powBits?: number;
};

const MAX_BODY_BYTES = 4096;
const PER_VISITOR = 5;
const PER_VISITOR_WINDOW_MS = 60 * 60_000;
const PER_DAY = 2000; // well inside the free plan's rows; a flood stops here
const MAX_VISITORS_HELD = 5000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entries (
    email TEXT PRIMARY KEY,
    joined_at TEXT NOT NULL,
    leave_hash TEXT NOT NULL UNIQUE,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS used_challenges (challenge TEXT PRIMARY KEY, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const BERTH_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
const hashHex = (text: string) => bytesToHex(sha256(utf8ToBytes(text)));

/** The same length of work whatever the strings, so an answer's timing says nothing. */
const sameSecret = (a: string, b: string) => hashHex(a) === hashHex(b);

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new Refusal(413, "that's too much text");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Refusal(413, "that's too much text");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Refusal(400, "send JSON");
  }
}

/** A cell that a spreadsheet won't run as a formula. */
export const csvCell = (value: string): string => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
};

/**
 * The waitlist. What it answers never says whether an email was already on it: a repeat
 * sign-up gets the same berth and a leave code like anyone else, but changes nothing. So no
 * count is served either: it would go up for a new email and not for a listed one.
 */
export function createWaitlist(deps: WaitlistDeps) {
  const now = deps.now ?? (() => new Date());
  const powBits = deps.powBits ?? POW_BITS;
  const rows = <T>(query: string, ...bindings: SqlValue[]) => deps.storage.sql.exec(query, ...bindings).toArray() as T[];
  rows(SCHEMA);

  const secret = (() => {
    const found = rows<{ value: string }>("SELECT value FROM settings WHERE key = 'secret'")[0];
    if (found) return found.value;
    const made = bytesToHex(randomBytes(32));
    rows("INSERT INTO settings (key, value) VALUES ('secret', ?)", made);
    return made;
  })();

  const visits = new Map<string, number[]>();
  const allowVisitor = (visitor: string, nowMs: number) => {
    const key = hashHex(`${secret}:${visitor}`); // an address is never held as it came
    const recent = (visits.get(key) ?? []).filter((at) => nowMs - at < PER_VISITOR_WINDOW_MS);
    if (recent.length >= PER_VISITOR) return false;
    if (visits.size >= MAX_VISITORS_HELD && !visits.has(key)) visits.clear();
    visits.set(key, [...recent, nowMs]);
    return true;
  };

  /** Made from the email, so it's the same each time and says nothing about who else is here. */
  const berthOf = (email: string) => {
    const digest = hmac(sha256, utf8ToBytes(secret), utf8ToBytes(`berth:${email}`));
    const letters = [...digest.slice(0, 6)].map((b) => BERTH_LETTERS[b % 32]).join("");
    return `${letters.slice(0, 3)}-${letters.slice(3)}`;
  };

  const join = (body: unknown, visitor: string) => {
    const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const at = now();
    const entry = parseEntry(raw);
    if (typeof entry === "string") throw new Refusal(400, entry);
    const problem = checkPow(secret, raw.challenge, raw.nonce, powBits, at.getTime());
    if (problem === "expired") throw new Refusal(410, "that took a while; send it once more");
    if (problem !== null) throw new Refusal(400, "the spam check didn't pass; reload and try again");
    if (!allowVisitor(visitor, at.getTime())) throw new Refusal(429, "that's a lot of sign-ups from one place; try again in an hour");

    const leaveCode = bytesToHex(randomBytes(12));
    // Bots fill every field; people never see this one. They get an answer and nothing is kept.
    const bot = typeof raw.website === "string" && raw.website !== "";
    if (!bot) save(entry, raw.challenge as string, leaveCode, at);
    return { berth: berthOf(entry.email), leaveCode };
  };

  const save = (entry: Entry, challenge: string, leaveCode: string, at: Date) =>
    deps.storage.transactionSync(() => {
      rows("DELETE FROM used_challenges WHERE at < ?", at.getTime() - CHALLENGE_TTL_MS);
      if (rows("SELECT 1 FROM used_challenges WHERE challenge = ?", challenge).length > 0) {
        throw new Refusal(409, "that was already sent; reload to send another");
      }
      const today = rows<{ n: number }>("SELECT count(*) AS n FROM entries WHERE joined_at >= ?", new Date(at.getTime() - 86_400_000).toISOString())[0]!.n;
      if (today >= PER_DAY) throw new Refusal(503, "the list is full for today; please come back tomorrow");
      rows("INSERT INTO used_challenges (challenge, at) VALUES (?, ?)", challenge, at.getTime());
      rows(
        "INSERT INTO entries (email, joined_at, leave_hash, json) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING",
        entry.email,
        at.toISOString(),
        hashHex(leaveCode),
        JSON.stringify({ ...entry, consent: CONSENT_VERSION }),
      );
    });

  const leave = (body: unknown) => {
    const code = (body as { leaveCode?: unknown } | null)?.leaveCode;
    const email = (body as { email?: unknown } | null)?.email;
    if (typeof code !== "string" || typeof email !== "string") throw new Refusal(400, "send your email and leave code");
    rows("DELETE FROM entries WHERE email = ? AND leave_hash = ?", cleanEmail(email) ?? "", hashHex(code.trim().toLowerCase()));
    return { ok: true }; // the same answer either way
  };

  const csv = () => {
    const list = rows<{ joined_at: string; json: string }>("SELECT joined_at, json FROM entries ORDER BY joined_at");
    const head = ["joined_at", "name", "email", "role", "venues", "chains", "size", "liquidated", "wants", "note"];
    const lines = list.map(({ joined_at, json }) => {
      const e = JSON.parse(json) as Entry;
      const was = e.liquidated === null ? "" : e.liquidated ? "yes" : "no";
      return [joined_at, e.name, e.email, e.role, e.venues.join(" "), e.chains.join(" "), e.size ?? "", was, e.wants.join(" "), e.note].map(csvCell).join(",");
    });
    return [head.join(","), ...lines].join("\r\n");
  };

  const headersFor = (request: Request): Record<string, string> => {
    const origin = request.headers.get("origin");
    const base = { vary: "origin", "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (origin === null || !deps.allowedOrigins.includes(origin)) return base;
    return { ...base, "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
  };

  const route = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const headers = headersFor(request);
    const json = (body: unknown) => Response.json(body, { headers });
    const key = `${request.method} ${pathname}`;
    if (key === "GET /") return json({ service: "lifeline-waitlist" });
    if (key === "GET /api/challenge") return json({ challenge: issueChallenge(secret, now().getTime()), bits: powBits });
    if (key === "GET /api/export" && deps.adminToken !== null) {
      const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!sameSecret(given, deps.adminToken)) throw new Refusal(401, "not allowed");
      return new Response(csv(), { headers: { ...headers, "content-type": "text/csv; charset=utf-8" } });
    }
    if (request.method === "POST" && (pathname === "/api/join" || pathname === "/api/leave")) {
      const origin = request.headers.get("origin");
      if (origin !== null && !deps.allowedOrigins.includes(origin)) throw new Refusal(403, "sign up from the Lifeline site");
      const body = await readJson(request);
      return json(pathname === "/api/join" ? join(body, request.headers.get("cf-connecting-ip") ?? "anyone") : leave(body));
    }
    throw new Refusal(404, "not found");
  };

  return {
    /** Answers a request. It never throws, and an unexpected error never says what it was. */
    async handle(request: Request): Promise<Response> {
      const headers = headersFor(request);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      try {
        return await route(request);
      } catch (error) {
        return error instanceof Refusal
          ? Response.json({ error: error.message }, { status: error.status, headers })
          : Response.json({ error: "something went wrong; please try again" }, { status: 500, headers });
      }
    },
  };
}
