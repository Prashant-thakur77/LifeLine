import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { ReceiptLink, ReceiptsResponse } from "./keeper";
import type { Judged } from "./verify";

// The keeper's decisions, relinked here. A hash proves nothing alone: what counts is that it
// follows from one this browser already held.

const GENESIS = "0".repeat(64);
const MAX_PAGES = 5;

/** As apps/keeper/src/receipts.ts; a test holds the two equal. */
export const linkHash = (previous: string, seq: number, json: string): string => bytesToHex(sha256(utf8ToBytes(`${previous}\n${seq}\n${json}`)));

/** The last link that follows from `from`, or the number of the first one that doesn't. */
export function relink(from: ReceiptLink | null, entries: ReceiptsResponse["entries"]): { last: ReceiptLink | null } | { brokenAt: number } {
  let last = from;
  for (const { seq, hash, json } of entries) {
    if (seq <= (last?.seq ?? 0) || linkHash(last?.hash ?? GENESIS, seq, json) !== hash) return { brokenAt: seq };
    last = { seq, hash };
  }
  return { last };
}

const sameLink = (a: ReceiptLink | null, b: ReceiptLink | null) => a?.seq === b?.seq && a?.hash === b?.hash;
const short = (link: ReceiptLink) => `no. ${link.seq}, ${link.hash.slice(0, 16)}…`;

/** Checks the log from the link this browser remembers, or just its newest stretch on a first visit. */
export async function checkReceipts(read: (after: number | null) => Promise<ReceiptsResponse>, witness: ReceiptLink | null): Promise<{ judged: Judged; witness: ReceiptLink | null }> {
  const failed = (finding: string): { judged: Judged; witness: null } => ({ judged: { verdict: "failed", finding, facts: witness ? [["This browser remembers", short(witness)]] : [] }, witness: null });
  let page = await read(witness?.seq ?? null);
  if (page.head === null) {
    return witness ? failed("The keeper says its log is empty, but this browser has seen records in it.") : { judged: { verdict: "trusted", finding: "The log has no sealed records yet.", facts: [] }, witness: null };
  }
  // The keeper must still hold the very link this browser remembers.
  if (witness !== null && !sameLink(page.before, witness)) return failed("A record this browser has already seen has been changed or removed.");

  let last = witness ?? page.before;
  let links = 0;
  for (let n = 1; ; n += 1) {
    const result = relink(last, page.entries);
    if ("brokenAt" in result) return failed(`Record ${result.brokenAt} doesn't follow from the one before it.`);
    last = result.last;
    links += page.entries.length;
    if (page.entries.length === 0 && (last?.seq ?? 0) < page.head.seq) return failed("The keeper says there are newer records and doesn't show them.");
    if (page.entries.length === 0 || last === null || last.seq >= page.head.seq || n >= MAX_PAGES) break;
    page = await read(last.seq);
    if (!sameLink(page.before, last)) return failed("The log changed while it was being read.");
    if (page.head === null) return failed("The log emptied while it was being read.");
  }
  if (last !== null && last.seq >= page.head.seq && !sameLink(last, page.head)) return failed("The newest link isn't the one the records lead to.");

  const facts: Judged["facts"] = [["Links checked here", String(links)], ...(last ? ([["Newest checked", short(last)]] as [string, string][]) : []), ...(witness ? ([["Remembered from before", short(witness)]] as [string, string][]) : [])];
  if (last === null || last.seq < page.head.seq) {
    return { judged: { verdict: "trusted", finding: `The records read so far follow from each other, but the log goes on to no. ${page.head.seq}. Run the checks again to go further.`, facts }, witness: last };
  }
  return witness
    ? { judged: { verdict: "proven", finding: "The link this browser remembered is still in place, and every record since follows from it, refusals included. Records from before that link were not read again.", facts }, witness: last }
    : { judged: { verdict: "trusted", finding: "The newest records follow from each other. On a first visit that could still be a freshly rewritten log. This browser now remembers the newest link, so your next visit checks that what comes after follows from it.", facts }, witness: last };
}

const key = (base: string) => `lifeline:receipts:${base}`;

export function loadWitness(base: string, storage: () => Pick<Storage, "getItem"> = () => localStorage): ReceiptLink | null {
  try {
    const value = JSON.parse(storage().getItem(key(base)) ?? "null") as ReceiptLink | null;
    return value !== null && Number.isInteger(value.seq) && value.seq > 0 && /^[0-9a-f]{64}$/.test(value.hash) ? { seq: value.seq, hash: value.hash } : null;
  } catch {
    return null;
  }
}

export function saveWitness(base: string, link: ReceiptLink, storage: () => Pick<Storage, "setItem"> = () => localStorage): void {
  try {
    storage().setItem(key(base), JSON.stringify(link));
  } catch {
    // Storage is blocked: the next visit is a first visit.
  }
}
