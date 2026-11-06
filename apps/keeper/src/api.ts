import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AttestationResponse, TelegramLinkResponse } from "@lifeline/shared";
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
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseLimit(params: URLSearchParams): number {
  const raw = params.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^[1-9]\d*$/.test(raw)) throw new HttpError(400, "limit must be a positive whole number");
  return Math.min(Number(raw), MAX_LIMIT);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
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

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "badly encoded path");
  }
}

/** Serves the REST API from the plan's Shared interfaces. It only reads the store. */
export function createApi(deps: ApiDeps): Server {
  const { store, now, botUsername, attestation, corsOrigin } = deps;

  const route = async (request: IncomingMessage, method: string, url: URL): Promise<unknown> => {
    const { pathname, searchParams } = url;
    const expect = (allowed: string) => {
      if (method !== allowed) throw new HttpError(405, `use ${allowed}`);
    };

    if (pathname.startsWith("/api/health/")) {
      expect("GET");
      const user = decodeSegment(pathname.slice("/api/health/".length));
      const health = store.health(user);
      if (health === null) throw new HttpError(404, "this user isn't being watched");
      return health;
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
      case "/api/telegram/link": {
        expect("POST");
        const user = parseLinkUser(await readBody(request));
        if (botUsername === null) throw new HttpError(503, "the Telegram bot isn't set up");
        const response: TelegramLinkResponse = { ...store.createTelegramCode(user, now()), botUsername };
        return response;
      }
      default:
        throw new HttpError(404, "not found");
    }
  };

  const respond = (response: ServerResponse, status: number, body?: unknown) => {
    response.writeHead(status, {
      "access-control-allow-origin": corsOrigin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };

  return createServer((request, response) => {
    const method = request.method ?? "GET";
    if (method === "OPTIONS") {
      respond(response, 204);
      return;
    }
    route(request, method, new URL(request.url ?? "/", "http://keeper")).then(
      (body) => respond(response, 200, body),
      (error: unknown) => {
        if (error instanceof HttpError) respond(response, error.status, { error: error.message });
        else respond(response, 500, { error: "internal error" });
      },
    );
  });
}
