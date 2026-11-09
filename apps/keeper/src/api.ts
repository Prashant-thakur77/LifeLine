import type { AttestationResponse, TelegramLinkResponse } from "@lifeline/shared";
import { isAttackId, LabBusy, LabClosed, type AttackLab } from "./attack-lab";
import type { Store } from "./store";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_BODY_BYTES = 1024;
const NEAR_ACCOUNT = /^[a-z0-9._-]{2,64}$/;

export const NOT_AVAILABLE_ATTESTATION: AttestationResponse = {
  status: "not available",
  checkedAt: null,
  model: null,
  checks: [],
};

export type ApiDeps = {
  store: Store;
  now: () => Date;
  botUsername: string | null; // null: no bot set up, so link codes can't be used
  attestation: () => AttestationResponse;
  corsOrigin: string;
  /** Says whether this account may have another link code now. Leave out for no limit. */
  allowLink?: (user: string, nowMs: number) => boolean;
  /** The public attack lab, on the demo keeper only. */
  lab?: AttackLab | null;
};

/**
 * At most 5 codes per account every 10 minutes and 30 a minute in all. Each code costs
 * storage writes, and the endpoint is public. Only watched accounts reach it, so the
 * map stays as small as the watch list.
 */
export function createLinkLimiter(perUser = 5, perUserWindowMs = 10 * 60_000, overall = 30, overallWindowMs = 60_000) {
  const byUser = new Map<string, number[]>();
  let everyone: number[] = [];
  return (user: string, nowMs: number): boolean => {
    const mine = (byUser.get(user) ?? []).filter((at) => nowMs - at < perUserWindowMs);
    everyone = everyone.filter((at) => nowMs - at < overallWindowMs);
    if (mine.length >= perUser || everyone.length >= overall) {
      byUser.set(user, mine);
      return false;
    }
    mine.push(nowMs);
    everyone.push(nowMs);
    byUser.set(user, mine);
    return true;
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const corsHeaders = (origin: string): Record<string, string> => ({
  "access-control-allow-origin": origin,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
});

export const jsonResponse = (status: number, body: unknown, origin: string): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(origin), "content-type": "application/json" } });

function parseLimit(params: URLSearchParams): number {
  const raw = params.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^[1-9]\d*$/.test(raw)) throw new HttpError(400, "limit must be a positive whole number");
  return Math.min(Number(raw), MAX_LIMIT);
}

/** Counts bytes as they arrive, so a body with no length, or a false one, can't run past the limit. */
async function readBody(request: Request): Promise<string> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseLinkUser(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  const user = (parsed as { user?: unknown } | null)?.user;
  if (typeof user !== "string" || !NEAR_ACCOUNT.test(user)) {
    throw new HttpError(400, "user must be a NEAR account");
  }
  return user;
}

function parseAttack(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  const attack = (parsed as { attack?: unknown } | null)?.attack;
  if (!isAttackId(attack)) throw new HttpError(400, "attack must be one of the lab's attack ids");
  return attack;
}

async function runAttack(lab: AttackLab, id: string): Promise<unknown> {
  try {
    return await lab.run(id as Parameters<AttackLab["run"]>[0]);
  } catch (error) {
    if (error instanceof LabBusy) throw new HttpError(429, `${error.message} (try again in ${error.retryAfterSec} s)`);
    if (error instanceof LabClosed) throw new HttpError(503, error.message);
    // Its outcome is unknown: the transaction may not have reached testnet.
    throw new HttpError(502, "the attack didn't get an answer from NEAR testnet; try again in a moment");
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "badly encoded path");
  }
}

async function route(request: Request, deps: ApiDeps): Promise<unknown> {
  const { store, now, botUsername, attestation } = deps;
  const { pathname, searchParams } = new URL(request.url);
  const expect = (allowed: string) => {
    if (request.method !== allowed) throw new HttpError(405, `use ${allowed}`);
  };

  if (pathname.startsWith("/api/health/")) {
    expect("GET");
    const user = decodeSegment(pathname.slice("/api/health/".length));
    const health = store.health(user);
    if (health === null) throw new HttpError(404, "this user isn't being watched");
    return health;
  }

  if (pathname.startsWith("/api/proof/")) {
    expect("GET");
    const id = decodeSegment(pathname.slice("/api/proof/".length));
    const user = searchParams.get("user");
    const proved = id === "latest" ? store.latestProof(user ?? undefined) : store.proof(id);
    if (proved === null) throw new HttpError(404, "no signed model answer is kept for this record");
    return proved;
  }

  switch (pathname) {
    case "/api/audit": {
      expect("GET");
      const user = searchParams.get("user");
      if (!user) throw new HttpError(400, "user is required");
      return store.audit(user, parseLimit(searchParams));
    }
    case "/api/ledger":
      expect("GET");
      return store.ledger(parseLimit(searchParams));
    case "/api/stats":
      expect("GET");
      return store.stats();
    case "/api/attestation":
      expect("GET");
      return attestation();
    case "/api/lab":
      expect("GET");
      if (!deps.lab) throw new HttpError(404, "the attack lab isn't set up on this keeper");
      return deps.lab.info();
    case "/api/lab/attack": {
      expect("POST");
      const attack = parseAttack(await readBody(request));
      if (!deps.lab) throw new HttpError(404, "the attack lab isn't set up on this keeper");
      return runAttack(deps.lab, attack);
    }
    case "/api/telegram/link": {
      expect("POST");
      const user = parseLinkUser(await readBody(request));
      if (botUsername === null) throw new HttpError(503, "the Telegram bot isn't set up");
      if (store.health(user) === null) throw new HttpError(404, "this user isn't being watched");
      if (deps.allowLink && !deps.allowLink(user, now().getTime())) {
        throw new HttpError(429, "too many link codes for this account; try again in a few minutes");
      }
      const response: TelegramLinkResponse = { ...store.createTelegramCode(user, now()), botUsername };
      return response;
    }
    default:
      throw new HttpError(404, "not found");
  }
}

/**
 * The REST API from the plan's Shared interfaces, as a plain Request-to-Response
 * function: the Cloudflare Worker calls it directly, and api-node.ts serves it in
 * Node. It only reads the store, apart from issuing link codes. It never throws.
 */
export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(deps.corsOrigin) });
  try {
    return jsonResponse(200, await route(request, deps), deps.corsOrigin);
  } catch (error) {
    return error instanceof HttpError
      ? jsonResponse(error.status, { error: error.message }, deps.corsOrigin)
      : jsonResponse(500, { error: "internal error" }, deps.corsOrigin);
  }
}
