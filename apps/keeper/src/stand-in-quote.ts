import { ASSETS, MAX_QUOTE_SLIPPAGE_BPS } from "@lifeline/shared";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

/**
 * A quote shaped and signed the way 1Click signs a real one, for the testnet vault only.
 * 1Click has no testnet, so the testnet vault trusts a team key (TESTNET_QUOTE_SIGNER_KEY)
 * in its place; the mainnet vault trusts 1Click's own key. `key` is a NEAR private key,
 * `ed25519:<base58 of the 32-byte seed and 32-byte public key>`. `refundTo` and `timestamp`
 * default to an honest quote's; the attack lab changes them to show the vault refusing.
 */
export function signTestnetQuote(options: {
  key: string;
  user: string;
  token: string;
  amount: string;
  recipient: string;
  depositAddress: string;
  now?: Date;
  refundTo?: string;
  timestamp?: Date;
}): { payload: string; signature: string } {
  const { key, user, token, amount, recipient, depositAddress } = options;
  const now = options.now ?? new Date();
  // Priced as 1Click prices it: 8-decimal value, less its flat fee and 1 bp, with a 1% slippage floor.
  const fee = 31_530_000n;
  const out = BigInt(amount) * 100n - fee - BigInt(amount) / 100n;
  const fields = {
    amount,
    amountIn: amount,
    amountOut: out.toString(),
    minAmountOut: (out - BigInt(amount)).toString(),
    withdrawFee: fee.toString(),
    depositAddress,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId,
    dry: false,
    originAsset: `nep141:${token}`,
    recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: options.refundTo ?? user,
    refundType: "ORIGIN_CHAIN",
    slippageTolerance: MAX_QUOTE_SLIPPAGE_BPS,
    swapType: "EXACT_INPUT",
    timestamp: (options.timestamp ?? new Date(now.getTime() - 2_000)).toISOString(),
  };
  const payload = JSON.stringify(fields);
  return { payload, signature: signStandIn(payload, key) };
}

/** The signature 1Click would give these exact bytes, made with the stand-in key. */
export function signStandIn(payload: string, key: string): string {
  const seed = base58.decode(key.replace(/^ed25519:/, "")).slice(0, 32);
  const message = new TextEncoder().encode(base58.encode(sha256(new TextEncoder().encode(payload))));
  return `ed25519:${base58.encode(ed25519.sign(message, seed))}`;
}
