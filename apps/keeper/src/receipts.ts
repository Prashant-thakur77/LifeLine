import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

// Each audit record is sealed with the hash of the one before it, so changing or removing
// an old record changes every hash after it. Anyone who kept an earlier hash can tell.

/** What the first record is chained to. */
export const GENESIS = "0".repeat(64);

/** The hash of one link: the previous hash, the record's number, and its exact bytes. */
export const linkHash = (previous: string, seq: number, json: string): string => bytesToHex(sha256(utf8ToBytes(`${previous}\n${seq}\n${json}`)));

export type Receipt = { seq: number; hash: string; json: string };
export type ReceiptsResponse = {
  /** The newest sealed link, or null when nothing is sealed yet. */
  head: { seq: number; hash: string } | null;
  /** The link just before `entries`, so the first one can be checked; null before the first record. */
  before: { seq: number; hash: string } | null;
  entries: Receipt[];
};
