import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const CHALLENGE_TTL_MS = 30 * 60_000; // long enough to answer every question
const CHALLENGE = /^([0-9]{13})\.([0-9a-f]{32})\.([0-9a-f]{64})$/;

/** How many zero bits a digest starts with. */
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export const powDigest = (challenge: string, nonce: string): Uint8Array => sha256(utf8ToBytes(`${challenge}:${nonce}`));

const sign = (secret: string, text: string) => bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(text)));

/** A signed, dated challenge, so the server keeps nothing until it's answered. */
export function issueChallenge(secret: string, nowMs: number): string {
  const text = `${String(nowMs).padStart(13, "0")}.${bytesToHex(randomBytes(16))}`;
  return `${text}.${sign(secret, text)}`;
}

export type PowProblem = "bad" | "expired" | "weak";

/** Null when the challenge is ours, fresh, and the nonce does the work. */
export function checkPow(secret: string, challenge: unknown, nonce: unknown, bits: number, nowMs: number): PowProblem | null {
  if (typeof challenge !== "string" || typeof nonce !== "string" || nonce.length > 32) return "bad";
  const match = CHALLENGE.exec(challenge);
  if (match === null || sign(secret, `${match[1]}.${match[2]}`) !== match[3]) return "bad";
  const age = nowMs - Number(match[1]);
  if (age < 0 || age > CHALLENGE_TTL_MS) return "expired";
  return leadingZeroBits(powDigest(challenge, nonce)) >= bits ? null : "weak";
}

export { CHALLENGE_TTL_MS };
