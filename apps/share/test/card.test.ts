import type { AccountRisk, RiskPosition } from "@lifeline/hyperliquid";
import { expect, test } from "vitest";
import { cardFor, cardSvg, cleanAddress, price, sharePage, shortAddress } from "../src/card";

const ADDRESS = `0x${"aB".repeat(20)}`;
const AT = Date.UTC(2026, 10, 24, 12);
const long = (over: Partial<RiskPosition> = {}): RiskPosition => ({ coin: "ETH", dex: "", size: 1, markPx: 3000, entryPx: 3000, liquidationPx: 2500, isolated: false, maintenanceRate: 0.02, ...over });
const risk = (over: Partial<AccountRisk> = {}): AccountRisk => ({ mode: "standard", value: 400, maintenance: 60, health: 400 / 60, covered: [long()], uncovered: [], keeperHealth: null, portfolioRatio: null, unread: [], ...over });

test("one position gives prices: equity meets maintenance near 2653", () => {
  // 400 + (p - 3000) = 0.02p, so p = 2653.06
  const card = cardFor(ADDRESS.toLowerCase(), risk(), AT)!;
  expect(card.title).toBe("ETH long, now $3,000");
  expect(Number(card.without.replace(/[$,]/g, ""))).toBeGreaterThan(2651);
  expect(Number(card.without.replace(/[$,]/g, ""))).toBeLessThanOrEqual(2655);
  expect(Number(card.withLifeline.replace(/[$,]/g, ""))).toBeLessThan(2640);
  expect(card.withLabel).toBe("With Lifeline, near");
  expect(card.caveat).toBe("");
});
test("several coins give a move, not a price", () => {
  const card = cardFor(ADDRESS, risk({ covered: [long(), long({ coin: "BTC", size: 0.01, markPx: 90000 })], maintenance: 78, health: 400 / 78 }), AT)!;
  expect(card.title).toBe("2 coins, all moving together");
  expect(card.without).toMatch(/^−\d+(\.\d)?%$/);
});
test("nothing to say about portfolio margin, no positions, a dead account or one nothing can kill", () => {
  expect(cardFor(ADDRESS, risk({ mode: "portfolio" }), AT)).toBeNull();
  expect(cardFor(ADDRESS, risk({ covered: [] }), AT)).toBeNull();
  expect(cardFor(ADDRESS, risk({ unread: ["xyz"] }), AT)).toBeNull();
  expect(cardFor(ADDRESS, risk({ health: 0.9 }), AT)).toBeNull();
  expect(cardFor(ADDRESS, risk({ value: 1e9, health: 1e9 }), AT)).toBeNull();
});
test("says what it leaves out, and what's untested", () => {
  expect(cardFor(ADDRESS, risk({ uncovered: [long({ isolated: true })] }), AT)!.caveat).toContain("1 position a top-up can't reach");
  expect(cardFor(ADDRESS, risk({ mode: "unified" }), AT)!.caveat).toContain("untested");
});
test("only a plain address is taken, and it's always shortened in what people see", () => {
  expect(cleanAddress(ADDRESS)).toBe(ADDRESS.toLowerCase());
  for (const bad of ["", "0x12", `${ADDRESS}0`, "vitalik.eth", `${ADDRESS.slice(0, -1)}"`]) expect(cleanAddress(bad)).toBeNull();
  const card = cardFor(ADDRESS.toLowerCase(), risk(), AT);
  expect(cardSvg(card)).toContain(shortAddress(ADDRESS.toLowerCase()));
  expect(cardSvg(card)).not.toContain(ADDRESS.toLowerCase());
});
test("a coin's name can't add markup", () => {
  const card = cardFor(ADDRESS, risk({ covered: [long({ coin: '<script>"&' })] }), AT);
  expect(cardSvg(card)).not.toContain("<script>");
  expect(sharePage("https://s.test", ADDRESS)).not.toContain("<script>");
});
test("the page carries the preview tags and goes on to the live test", () => {
  const html = sharePage("https://s.test", ADDRESS);
  for (const part of ['name="twitter:card" content="summary_large_image"', `content="https://s.test/${ADDRESS}.png"`, "noindex", `/check?address=${ADDRESS}`]) expect(html).toContain(part);
  expect(html).not.toContain("$");
  expect(cardSvg(null)).toContain("Storm-test any");
});
test("prices read naturally at every scale", () => {
  expect([price(91234.5), price(12.345), price(0.1234567), price(0.00001234)]).toEqual(["$91,235", "$12.35", "$0.1235", "$0.00001234"]);
});
