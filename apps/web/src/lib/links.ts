import type { Network } from "./config";
import type { LedgerEvent } from "./records";

// Explorer URL formats, checked on 2026-11-08:
// - NearBlocks: /txns/<hash> and /address/<account>, testnet on testnet.nearblocks.io.
// - NEAR Intents explorer: /transactions/<deposit address>, the page its own search opens.
// - Hyperliquid: /explorer/address/<0x address>, which shows the account's perps activity.

const nearblocksHost = (network: Network) => (network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io");

export const nearblocksTx = (hash: string, network: Network) => `${nearblocksHost(network)}/txns/${encodeURIComponent(hash)}`;

export const nearblocksAccount = (account: string, network: Network) =>
  `${nearblocksHost(network)}/address/${encodeURIComponent(account)}`;

export const intentsExplorer = (depositAddress: string) =>
  `https://explorer.near-intents.org/transactions/${encodeURIComponent(depositAddress)}`;

export const hyperliquidAddress = (address: string) =>
  `https://app.hyperliquid.xyz/explorer/address/${encodeURIComponent(address)}`;

/** Opens the bot with the code filled in: the bot links the chat on /start <code>. */
export const telegramStart = (botUsername: string, code: string) =>
  `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(code)}`;

export type ExternalLink = { label: string; href: string };

/**
 * Where to check an event independently. A simulated event has nothing on chain, so it
 * gets no links at all rather than links to pages that don't exist.
 */
export function eventLinks(event: LedgerEvent, network: Network): ExternalLink[] {
  if (event.simulated) return [];
  const links: ExternalLink[] = [];
  if (event.nearTx) links.push({ label: "NEAR transaction", href: nearblocksTx(event.nearTx, network) });
  if (event.request && event.outcome !== "blocked") {
    links.push({ label: "1Click swap", href: intentsExplorer(event.request.depositAddress) });
  }
  // The user's own address from the health reading: on a blocked rescue the request's
  // recipient may be exactly the wrong address that got it refused.
  // Except when it was refused for SNAPSHOT_MISMATCH: then the reading was for some other address.
  if (event.request && !event.reasons.includes("SNAPSHOT_MISMATCH")) {
    links.push({ label: "Hyperliquid account", href: hyperliquidAddress(event.request.snapshot.hlAddress) });
  }
  return links;
}

/** An in-app link that keeps the account being viewed: /position?user=demo.near. */
export function pageHref(path: string, user?: string | null): string {
  return user ? `${path}?user=${encodeURIComponent(user)}` : path;
}
