import type { Quote } from "./types";

const UNITS = /^\d+$/;

/** 0x addresses compare in any case; anything else, like a NEAR account, exactly. */
function sameRecipient(a: string, b: string): boolean {
  return a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The fields of a quote that don't match what the caller expects, all at once. An empty
 * list means it pays the right recipient, the right asset, and at least `minAmountOut`.
 * Check the quote's signature first (createOneClick does): this only reads its fields.
 */
export function verifyQuote(
  quote: Quote,
  expected: { recipient: string; destinationAsset: string; minAmountOut: string },
): ("recipient" | "destinationAsset" | "minAmountOut")[] {
  const problems: ("recipient" | "destinationAsset" | "minAmountOut")[] = [];
  if (!sameRecipient(quote.recipient, expected.recipient)) problems.push("recipient");
  if (quote.destinationAsset !== expected.destinationAsset) problems.push("destinationAsset");
  const readable = UNITS.test(quote.minAmountOut) && UNITS.test(expected.minAmountOut);
  if (!readable || BigInt(quote.minAmountOut) < BigInt(expected.minAmountOut)) problems.push("minAmountOut");
  return problems;
}
