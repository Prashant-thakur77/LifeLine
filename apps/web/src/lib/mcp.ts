// The agents page speaks to the MCP server the way an agent does.

export const MCP_URL = (process.env.NEXT_PUBLIC_MCP_URL ?? "").trim() || "https://lifeline-mcp.prashantthakur.dev/mcp";
const VERSION = "2026-07-28";

export type McpProp = { type: string; description: string; enum?: string[]; minimum?: number; maximum?: number };
export type McpTool = { name: string; title: string; description: string; inputSchema: { properties: Record<string, McpProp>; required?: string[] } };
export type McpAnswer = { isError: boolean; text: string };

async function rpc(method: string, params: Record<string, unknown>, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchFn(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": VERSION,
        "mcp-method": method,
        ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": VERSION, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "lifeline-site", version: "1" } } },
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Couldn't reach the MCP server. Try again in a moment.");
  }
  const body = (await response.json().catch(() => null)) as { result?: Record<string, unknown>; error?: { message?: string } } | null;
  if (!body?.result) throw new Error(body?.error?.message ?? `The MCP server answered ${response.status}.`);
  return body.result;
}

export const listTools = async (fetchFn: typeof fetch = fetch) => (await rpc("tools/list", {}, fetchFn)).tools as McpTool[];

export async function runTool(name: string, args: Record<string, unknown>, fetchFn: typeof fetch = fetch): Promise<McpAnswer> {
  const result = (await rpc("tools/call", { name, arguments: args }, fetchFn)) as { isError?: boolean; structuredContent?: unknown; content?: { text?: string }[] };
  const isError = result.isError === true;
  return { isError, text: isError || result.structuredContent === undefined ? (result.content?.[0]?.text ?? "") : JSON.stringify(result.structuredContent, null, 2) };
}

/** What was typed, as the tool's types. Empty fields are left out. */
export function toArguments(tool: McpTool, typed: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tool.inputSchema.properties).flatMap(([name, prop]) => {
      const value = typed[name]?.trim() ?? "";
      if (value === "") return [];
      return [[name, prop.type === "number" || prop.type === "integer" ? Number(value) : value]];
    }),
  );
}
