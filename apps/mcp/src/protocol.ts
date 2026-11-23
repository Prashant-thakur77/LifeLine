import { problemWith, type Args } from "./schema";
import { TOOLS, ToolError, type ToolDeps } from "./tools";

// MCP over HTTP, with no session and no state. It speaks the 2026-07-28 revision, where
// each request carries its own version, and the older one that opens with `initialize`.
// https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http

export const MODERN = "2026-07-28";
const LEGACY = ["2025-11-25", "2025-06-18"] as const;
const SUPPORTED = [MODERN, ...LEGACY];
export const SERVER_INFO = { name: "lifeline", title: "Lifeline", version: "1.4.0" };
export const INSTRUCTIONS =
  "Lifeline tops up Hyperliquid margin before liquidation, from a vault on NEAR that only ever pays the user's own address. These tools read public data and prepare UNSIGNED transactions; none can move money. Show the user every summary and warning, treat a warning of severity error as a stop, and never ask for a private key or seed phrase. A reading that couldn't be made is unknown, never safe.";

const V = "io.modelcontextprotocol/protocolVersion";
const C = "io.modelcontextprotocol/clientCapabilities";
const CACHE = { ttlMs: 3_600_000, cacheScope: "public" };
const MAX_BODY = 16_384;

type Id = string | number | null;
export type McpDeps = { tools: ToolDeps; allowedOrigins: string[]; allow: (visitor: string) => boolean; log?: (line: string) => void };

const listed = TOOLS.map(({ run: _run, ...tool }) => tool);

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly status: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A header may carry a name as =?base64?…?=, for characters a header can't hold. */
function decodeHeader(value: string): string {
  const packed = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(value);
  if (packed === null) return value;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(packed[1]!), (c) => c.charCodeAt(0)));
  } catch {
    return value;
  }
}

async function callTool(params: Record<string, unknown>, deps: McpDeps): Promise<Record<string, unknown>> {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (tool === undefined) throw new RpcFailure(-32602, "unknown tool", 200);
  const args = params.arguments ?? {};
  const wrong = problemWith(tool.inputSchema, args);
  // The model can fix its own arguments, so this is an answer rather than a protocol error.
  const failed = (text: string) => ({ content: [{ type: "text", text }], isError: true });
  if (wrong !== null) return failed(wrong);
  try {
    const structuredContent = await tool.run(args as Args, deps.tools);
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: false };
  } catch (error) {
    if (error instanceof ToolError) return failed(error.message);
    deps.log?.(`${tool.name} failed: ${error instanceof Error ? error.name : "unknown"}`);
    return failed("Something went wrong. Nothing was changed.");
  }
}

const reply = (status: number, body: unknown, headers: Record<string, string>) => Response.json(body, { status, headers });
const failure = (id: Id, e: RpcFailure) => ({ jsonrpc: "2.0", id, error: { code: e.code, message: e.message, ...(e.data === undefined ? {} : { data: e.data }) } });

/** The modern revision's headers must be there and agree with the body. */
function checkModern(request: Request, method: string, params: Record<string, unknown>, meta: Record<string, unknown>) {
  const header = request.headers.get("mcp-protocol-version");
  if (header === null || header !== meta[V]) throw new RpcFailure(-32020, "MCP-Protocol-Version is missing or differs from the body", 400);
  if (meta[V] !== MODERN) throw new RpcFailure(-32022, "unsupported protocol version", 400, { supported: SUPPORTED, requested: String(meta[V]).slice(0, 32) });
  if (!isRecord(meta[C])) throw new RpcFailure(-32602, "_meta needs clientCapabilities", 400);
  if (request.headers.get("mcp-method") !== method) throw new RpcFailure(-32020, "Mcp-Method is missing or differs from the body", 400);
  if (method === "tools/call") {
    const name = request.headers.get("mcp-name");
    if (name === null || decodeHeader(name) !== params.name) throw new RpcFailure(-32020, "Mcp-Name is missing or differs from the body", 400);
  }
}

async function dispatch(request: Request, message: Record<string, unknown>, deps: McpDeps): Promise<Record<string, unknown>> {
  const method = message.method as string;
  const params = message.params === undefined ? {} : message.params;
  if (!isRecord(params)) throw new RpcFailure(-32602, "params must be an object", 400);
  const meta = isRecord(params._meta) ? params._meta : {};
  const modern = meta[V] !== undefined || request.headers.get("mcp-method") !== null || request.headers.get("mcp-protocol-version") === MODERN;

  if (modern) {
    checkModern(request, method, params, meta);
    const info = { "io.modelcontextprotocol/serverInfo": SERVER_INFO };
    if (method === "server/discover") return { resultType: "complete", supportedVersions: SUPPORTED, capabilities: { tools: {} }, instructions: INSTRUCTIONS, ...CACHE, _meta: info };
    if (method === "tools/list") return { resultType: "complete", tools: listed, ...CACHE, _meta: info };
    if (method === "tools/call") return { resultType: "complete", ...(await callTool(params, deps)), _meta: info };
    throw new RpcFailure(-32601, "unknown method", 404);
  }

  const stated = request.headers.get("mcp-protocol-version");
  if (stated !== null && !LEGACY.includes(stated as (typeof LEGACY)[number])) throw new RpcFailure(-32022, "unsupported protocol version", 400, { supported: SUPPORTED });
  if (method === "initialize") {
    const wanted = LEGACY.find((v) => v === params.protocolVersion) ?? LEGACY[0];
    return { protocolVersion: wanted, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: listed };
  if (method === "tools/call") return callTool(params, deps);
  throw new RpcFailure(-32601, "unknown method", 200);
}

export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
  const origin = request.headers.get("origin");
  // A browser page from elsewhere is turned away; agents outside a browser send no Origin.
  if (origin !== null && !deps.allowedOrigins.includes(origin)) return reply(403, failure(null, new RpcFailure(-32600, "origin not allowed", 403)), {});
  const headers: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    vary: "origin",
    ...(origin === null ? {} : { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-method, mcp-name" }),
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, allow: "POST, OPTIONS" } });
  if (!deps.allow(request.headers.get("cf-connecting-ip") ?? "anyone")) return reply(429, failure(null, new RpcFailure(-32600, "too many requests; wait a minute", 429)), { ...headers, "retry-after": "60" });

  let id: Id = null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new RpcFailure(-32600, "body too large", 413);
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      throw new RpcFailure(-32700, "not JSON", 400);
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") throw new RpcFailure(-32600, "one JSON-RPC request per POST", 400);
    if (message.id === undefined) return new Response(null, { status: 202, headers });
    if (typeof message.id !== "string" && typeof message.id !== "number") throw new RpcFailure(-32600, "id must be a string or a number", 400);
    id = message.id;
    return reply(200, { jsonrpc: "2.0", id, result: await dispatch(request, message, deps) }, headers);
  } catch (error) {
    const known = error instanceof RpcFailure ? error : new RpcFailure(-32603, "internal error", 500);
    return reply(known.status, failure(id, known), headers);
  }
}

/** At most `perMinute` calls a minute from one visitor. Kept in memory, so it's per machine: a brake, not a wall. */
export function createLimiter(perMinute: number, now: () => number = Date.now) {
  const seen = new Map<string, { minute: number; n: number }>();
  return (visitor: string): boolean => {
    const minute = Math.floor(now() / 60_000);
    if (seen.size > 5000) seen.clear();
    const entry = seen.get(visitor);
    if (entry === undefined || entry.minute !== minute) {
      seen.set(visitor, { minute, n: 1 });
      return true;
    }
    entry.n += 1;
    return entry.n <= perMinute;
  };
}
