import { createLimiter, handleMcp, SERVER_INFO } from "./protocol";
import { infoReader, keeperReader, vaultReader } from "./readers";

type Env = { ALLOWED_ORIGINS: string };
const allow = createLimiter(60);

export default {
  fetch: async (request, env) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return Response.json({ service: "lifeline-mcp", version: SERVER_INFO.version, endpoint: "/mcp", docs: "https://lifeline.prashantthakur.dev/agents" });
    if (pathname !== "/mcp") return Response.json({ error: "not found" }, { status: 404 });
    const send: typeof fetch = (input, init) => fetch(input, init);
    return handleMcp(request, {
      allowedOrigins: env.ALLOWED_ORIGINS.split(","),
      allow,
      log: (line) => console.log(line),
      tools: { info: infoReader(send), vault: vaultReader(send), keeper: keeperReader(send), now: () => new Date() },
    });
  },
} satisfies ExportedHandler<Env>;
