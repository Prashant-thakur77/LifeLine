import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ASSETS, POLICY_DEFAULTS, type AuditRecord, type HealthSnapshot, type Policy, type RescueRequest } from "@lifeline/shared";

export const USER = "alice.near";
export const HL = "0x1111111111111111111111111111111111111111";
export const AT = "2026-11-08T15:00:00.000Z";

export const policy = (o: Partial<Policy> = {}): Policy => ({
  user: USER,
  hlAddress: HL,
  ...POLICY_DEFAULTS,
  paused: false,
  ...o,
});

export const snapshot = (accountValue: number, maintenanceMarginUsed: number, at = AT): HealthSnapshot => ({
  hlAddress: HL,
  accountValue,
  maintenanceMarginUsed,
  health: maintenanceMarginUsed === 0 ? Number.POSITIVE_INFINITY : accountValue / maintenanceMarginUsed,
  positions: [{ coin: "ETH", size: 0.1, entryPx: 3000, liquidationPx: 2500 }],
  at,
});

export const rescueRequest = (o: Partial<RescueRequest> = {}): RescueRequest => ({
  id: "req-1",
  user: USER,
  token: ASSETS.NEAR_USDC.contractId,
  amount: "5000000",
  usdNeeded: 4.6,
  quoteId: "quote-1",
  depositAddress: "deposit-1",
  recipient: HL,
  quoteAt: AT,
  snapshot: snapshot(50, 34),
  ...o,
});

export const record = (o: Partial<AuditRecord> & { id: string; kind: AuditRecord["kind"] }): AuditRecord => ({
  user: USER,
  at: AT,
  ...o,
});

/** A stand-in for the model enclave's key, signing the way NEAR AI Cloud does: Ethereum personal-sign. */
export function testSigner(seed = 7) {
  const secret = new Uint8Array(32).fill(seed);
  const publicKey = secp256k1.getPublicKey(secret, false);
  const address = `0x${Buffer.from(keccak_256(publicKey.subarray(1))).subarray(12).toString("hex")}`;
  const sign = (text: string, v: "27" | "0" = "27") => {
    const message = new TextEncoder().encode(text);
    const digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`), ...message]));
    const sig = secp256k1.Signature.fromBytes(secp256k1.sign(digest, secret, { prehash: false, format: "recovered" }), "recovered");
    const tail = (v === "27" ? 27 : 0) + (sig.recovery ?? 0);
    return `0x${Buffer.from(sig.toBytes("compact")).toString("hex")}${tail.toString(16).padStart(2, "0")}`;
  };
  return { address, sign };
}
