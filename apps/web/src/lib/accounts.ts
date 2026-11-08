// NEAR account IDs: 2 to 64 characters of a-z, 0-9 and the separators - _ . with no
// separator at either end or next to another. Implicit accounts (64 hex) pass too.
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isNearAccount(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && NEAR_ACCOUNT.test(value);
}

/** What the vault accepts: 0x and 40 hex characters, in any case. It stores lower case. */
export function isHlAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function hlAddressError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Enter the address you trade with on Hyperliquid.";
  if (!trimmed.startsWith("0x")) return "A Hyperliquid address starts with 0x.";
  if (trimmed.length !== 42) return `A Hyperliquid address is 0x and 40 characters; this one has ${trimmed.length - 2}.`;
  if (!isHlAddress(trimmed)) return "Only 0-9 and a-f can follow the 0x.";
  return null;
}
