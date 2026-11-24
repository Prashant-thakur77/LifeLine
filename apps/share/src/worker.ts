import { DurableObject } from "cloudflare:workers";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import { SITE, cardSvg, cleanAddress, readCard, sharePage } from "./card";
import { createBudget } from "./budget";

type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
type Env = { PAINTER: DurableObjectNamespace<Painter>; PER_VISITOR: Limiter; ASSETS: Fetcher };

const HOME = "https://lifeline-share.prashantthakur.dev";
// Fixed files, so nothing a caller sends ever becomes a URL.
const FONTS = [
  "https://fonts.gstatic.com/s/archivo/v25/k3k6o8UDI-1M0wlSV9XAw6lQkqWY8Q9osJaRE-NWIDdgffTTtDRp8A.ttf",
  "https://fonts.gstatic.com/s/archivo/v25/k3k6o8UDI-1M0wlSV9XAw6lQkqWY8Q82sJaRE-NWIDdgffTT6jRp8A.ttf",
];

const read = async (body: Record<string, unknown>): Promise<unknown> => {
  const response = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(6_000) });
  if (!response.ok) throw new Error(`Hyperliquid answered ${response.status}`);
  return response.json();
};

let ready: Promise<Uint8Array[]> | null = null;
/** The renderer and its fonts, once. A failure is tried again next time. */
const tools = () =>
  (ready ??= (async () => {
    const fonts = Promise.all(
      FONTS.map(async (url) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(6_000) });
        if (!response.ok) throw new Error(`font: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      }),
    );
    await initWasm(wasm).catch((error: unknown) => {
      if (!String(error).includes("Already initialized")) throw error;
    });
    return fonts;
  })().catch((error: unknown) => {
    ready = null;
    throw error;
  }));

/** Draws one picture and nothing else, so it is awake for a moment per new card. The account is read before it's asked. */
export class Painter extends DurableObject<Env> {
  async draw(svg: string): Promise<Uint8Array> {
    const image = new Resvg(svg, { font: { fontBuffers: await tools(), defaultFontFamily: "Archivo", loadSystemFonts: false } });
    const rendered = image.render();
    try {
      return rendered.asPng();
    } finally {
      rendered.free();
      image.free();
    }
  }
}

// The Worker's own cap on new pictures, besides each visitor's: the keeper shares this account's free plan.
const budget = createBudget({ perMinute: 10, perDay: 300 });
const general = (env: Env) => env.ASSETS.fetch(`${HOME}/general.png`).then((r) => new Response(r.body, { headers: { "content-type": "image/png", "cache-control": "no-store" } }));

async function picture(address: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(`${HOME}/${address}.png`);
  const held = await cache.match(key);
  if (held) return held;
  const visitor = await env.PER_VISITOR.limit({ key: request.headers.get("cf-connecting-ip") ?? "anyone" });
  if (!visitor.success || !budget(Date.now())) return general(env);
  // A failed read isn't kept, so the next visit tries again.
  const card = await readCard(address, read, Date.now()).catch(() => "unread" as const);
  if (card === "unread" || card === null) return general(env);
  const png = await env.PAINTER.get(env.PAINTER.idFromName("painter")).draw(cardSvg(card));
  const answer = new Response(png, { headers: { "content-type": "image/png", "cache-control": "public, max-age=300" } });
  ctx.waitUntil(cache.put(key, answer.clone()));
  return answer;
}

export default {
  fetch: async (request, env, ctx) => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("not allowed", { status: 405 });
    const { pathname } = new URL(request.url);
    if (pathname === "/") return Response.redirect(`${SITE}/check`, 302);
    const [, raw = "", png] = /^\/([^./]*)(\.png)?$/.exec(pathname) ?? [];
    const address = cleanAddress(raw);
    if (address === null) return new Response("not found", { status: 404 });
    if (png) return picture(address, request, env, ctx).catch(() => general(env));
    return new Response(sharePage(HOME, address), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "content-security-policy": "default-src 'none'", "referrer-policy": "no-referrer" } });
  },
} satisfies ExportedHandler<Env>;
