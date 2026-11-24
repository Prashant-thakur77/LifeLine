import { readAccountRisk, storm, suggestPlan, worseDirection, type AccountRisk, type InfoReader } from "@lifeline/hyperliquid";
import { POLICY_DEFAULTS } from "@lifeline/shared";

// What a shared storm test says. Only the shortened address appears, never a name.

const FLAT_FEE_USD = 0.3153; // 1Click's, as measured on 2026-11-06
const RANGE = { down: -90, up: 150 } as const;
export const SITE = "https://lifeline.prashantthakur.dev";

export type Card = { address: string; at: number; title: string; without: string; withLifeline: string; detail: string };

/** The address in lower case, or null when it isn't one. */
export const cleanAddress = (raw: string): string | null => (/^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : null);
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export const price = (value: number): string => {
  const digits = value >= 1000 ? 0 : value >= 1 ? 2 : Math.min(8, 3 - Math.floor(Math.log10(value)));
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: value >= 1 ? digits : 0, maximumFractionDigits: digits })}`;
};
const percent = (pct: number) => `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`;

/** The same storm the site runs, at its suggested plan. Null when there's nothing it can say. */
export function cardFor(address: string, risk: AccountRisk, at: number): Card | null {
  if (risk.mode === "portfolio" || risk.covered.length === 0 || !(risk.health > 1)) return null;
  const direction = worseDirection(risk);
  const plan = suggestPlan(risk, POLICY_DEFAULTS, FLAT_FEE_USD);
  const limit = direction < 0 ? RANGE.down : RANGE.up;
  const result = storm(risk, limit, plan);
  if (result.diesWithout === null) return null;
  const coins = [...new Set(risk.covered.map((p) => p.coin))];
  const only = coins.length === 1 ? risk.covered[0]! : null;
  const at_ = (pct: number | null, none: string) => (pct === null ? none : only ? price(only.markPx * (1 + pct / 100)) : percent(pct));
  const reserve = `$${Math.round(plan.reserveUsd).toLocaleString("en-US")}`;
  return {
    address,
    at,
    title: only ? `${only.coin} ${only.size > 0 ? "long" : "short"}, now ${price(only.markPx)}` : `${coins.length} coins, all moving together`,
    without: at_(result.diesWithout, ""),
    withLifeline: result.rescues.length === 0 ? at_(result.diesWithout, "") : at_(result.diesWith, `past ${percent(limit)}`),
    detail: `Estimate with a ${reserve} reserve. Assumes the market moves slowly enough for rescues to land.`,
  };
}

export async function readCard(address: string, read: InfoReader, at: number): Promise<Card | null> {
  return cardFor(address, await readAccountRisk(address, read), at);
}

const xml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Plain text a font can draw: a coin's name comes from the API. */
const plain = (text: string, max: number) => xml([...text.replace(/[^\x20-\x7e…−×·]/g, "")].slice(0, max).join(""));
const size = (text: string, most: number, width: number) => Math.min(most, Math.floor(width / (text.length * 0.52)));
const stamp = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** 1200 × 630, the size link previews use. A null card is the general one. */
export function cardSvg(card: Card | null): string {
  const buoy = `<g transform="translate(1066 92)"><circle r="40" fill="none" stroke="#0b1533" stroke-width="31"/><circle r="40" fill="none" stroke="#fffcf5" stroke-width="25"/><circle r="40" fill="none" stroke="#ff5a1f" stroke-width="25" stroke-dasharray="31.42 31.42" transform="rotate(-22.5)"/></g>`;
  const head = `<rect width="1200" height="630" fill="#fff7ea"/><rect x="0" y="0" width="1200" height="184" fill="#1d4bff"/><rect y="180" width="1200" height="6" fill="#0b1533"/>${buoy}`;
  const t = (x: number, y: number, px: number, text: string, fill = "#0b1533", weight = 800) => `<text x="${x}" y="${y}" font-family="Archivo" font-size="${px}" font-weight="${weight}" fill="${fill}">${text}</text>`;
  const body = card
    ? [
        t(60, 100, 62, "STORM TEST", "#fffcf5"),
        t(60, 148, 32, `${plain(shortAddress(card.address), 20)} · ${plain(card.title, 46)}`, "#fffcf5", 600),
        `<rect x="60" y="232" width="520" height="250" rx="14" fill="#ffe1e4" stroke="#0b1533" stroke-width="5"/>`,
        t(92, 290, 32, "Liquidated without Lifeline", "#0b1533", 600),
        t(92, 420, size(card.without, 120, 456), plain(card.without, 18)),
        `<rect x="620" y="232" width="520" height="250" rx="14" fill="#ffd3bf" stroke="#0b1533" stroke-width="5"/>`,
        t(652, 290, 32, card.withLifeline.startsWith("past") ? "With Lifeline, survives" : "Liquidated with Lifeline", "#0b1533", 600),
        t(652, 420, size(card.withLifeline, 120, 456), plain(card.withLifeline, 18)),
        t(60, 536, 24, plain(card.detail, 110), "#3b4568", 600),
        t(60, 590, 28, `Read ${stamp(card.at)} · lifeline.prashantthakur.dev/check`, "#0b1533", 600),
      ]
    : [t(60, 120, 76, "LIFELINE", "#fffcf5"), t(60, 320, 92, "Storm-test any"), t(60, 420, 92, "Hyperliquid address."), t(60, 560, 34, "lifeline.prashantthakur.dev/check", "#0b1533", 600)];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">${head}${body.join("")}</svg>`;
}

/** The page a share link opens: preview tags for crawlers, then straight on to the live test. */
export function sharePage(origin: string, address: string, card: Card | null): string {
  const to = `${SITE}/check?address=${address}`;
  const title = `Storm test: ${shortAddress(address)}`;
  const said = card ? `Liquidated at ${card.without} without Lifeline, ${card.withLifeline} with it. Read ${stamp(card.at)}; an estimate.` : "See what market move liquidates this account, with and without Lifeline.";
  const image = `${origin}/${address}.png`;
  const tags: [string, string, string][] = [
    ["property", "og:type", "website"],
    ["property", "og:site_name", "Lifeline"],
    ["property", "og:url", `${origin}/${address}`],
    ["property", "og:title", title],
    ["property", "og:description", said],
    ["property", "og:image", image],
    ["property", "og:image:width", "1200"],
    ["property", "og:image:height", "630"],
    ["property", "og:image:alt", said],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", title],
    ["name", "twitter:description", said],
    ["name", "twitter:image", image],
    ["name", "twitter:image:alt", said],
    ["name", "description", said],
    ["name", "robots", "noindex"],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${xml(title)}</title>${tags
    .map(([kind, name, content]) => `<meta ${kind}="${name}" content="${xml(content)}">`)
    .join("")}<meta http-equiv="refresh" content="0;url=${xml(to)}"></head><body><p>${xml(said)}</p><p><a href="${xml(to)}">Open the live storm test</a></p></body></html>`;
}
