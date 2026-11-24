import { DurableObject } from "cloudflare:workers";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import { SITE, cardSvg, cleanAddress, readCard, sharePage, type Card } from "./card";

type Env = { CARDS: DurableObjectNamespace<Cards> };
type Made = { at: number; card: Card | null; png: Uint8Array };

// Fixed files, so nothing a caller sends ever becomes a URL.
const FONTS = [
  "https://fonts.gstatic.com/s/archivo/v25/k3k6o8UDI-1M0wlSV9XAw6lQkqWY8Q9osJaRE-NWIDdgffTTtDRp8A.ttf",
  "https://fonts.gstatic.com/s/archivo/v25/k3k6o8UDI-1M0wlSV9XAw6lQkqWY8Q82sJaRE-NWIDdgffTT6jRp8A.ttf",
];
const FRESH_MS = 5 * 60_000;
const MAX_HELD = 200;
const PER_MINUTE = 20; // new readings; past it the general card is served

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

export class Cards extends DurableObject<Env> {
  private readonly made = new Map<string, Made>();
  private readonly making = new Map<string, Promise<Made>>();
  private recent: number[] = [];

  private async make(key: string, address: string | null): Promise<Made> {
    const card = address === null ? null : await readCard(address, read, Date.now()).catch(() => null);
    const image = new Resvg(cardSvg(card), { font: { fontBuffers: await tools(), defaultFontFamily: "Archivo", loadSystemFonts: false } });
    const result = { at: Date.now(), card, png: image.render().asPng() };
    if (this.made.size >= MAX_HELD) this.made.delete(this.made.keys().next().value!);
    this.made.set(key, result);
    return result;
  }

  private get(address: string | null): Promise<Made> {
    const key = address ?? "general";
    const held = this.made.get(key);
    if (held && Date.now() - held.at < FRESH_MS) return Promise.resolve(held);
    const running = this.making.get(key);
    if (running) return running;
    if (address !== null) {
      this.recent = this.recent.filter((at) => Date.now() - at < 60_000);
      if (this.recent.length >= PER_MINUTE) return held ? Promise.resolve(held) : this.get(null);
      this.recent.push(Date.now());
    }
    const work = this.make(key, address).finally(() => this.making.delete(key));
    this.making.set(key, work);
    return work;
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const [, raw = "", png] = /^\/([^./]*)(\.png)?$/.exec(pathname) ?? [];
    const address = cleanAddress(raw);
    const { card, png: image } = await this.get(address);
    if (png) return new Response(image, { headers: { "content-type": "image/png", "cache-control": "public, max-age=300" } });
    return new Response(sharePage("https://lifeline-share.prashantthakur.dev", address!, card), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "content-security-policy": "default-src 'none'", "referrer-policy": "no-referrer" } });
  }
}

export default {
  fetch: async (request, env) => {
    const { pathname } = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("not allowed", { status: 405 });
    const [, raw = "", png] = /^\/([^./]*)(\.png)?$/.exec(pathname) ?? [];
    if (pathname === "/") return Response.redirect(`${SITE}/check`, 302);
    if (cleanAddress(raw) === null && !(raw === "general" && png)) return new Response("not found", { status: 404 });
    try {
      return await env.CARDS.get(env.CARDS.idFromName("cards")).fetch(request);
    } catch {
      return png ? new Response("no picture just now", { status: 503 }) : Response.redirect(`${SITE}/check?address=${raw}`, 302);
    }
  },
} satisfies ExportedHandler<Env>;
