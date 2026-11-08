import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ASSETS, MAX_QUOTE_SLIPPAGE_BPS } from "@lifeline/shared";
import { base58 } from "@scure/base";

/**
 * A quote shaped and signed the way 1Click signs a real one, for the testnet vault only.
 * 1Click has no testnet, so the testnet vault trusts a team key (TESTNET_QUOTE_SIGNER_KEY)
 * in its place; the mainnet vault trusts 1Click's own key. `key` is a NEAR private key,
 * `ed25519:<base58 of the 32-byte seed and 32-byte public key>`.
 */
export function signTestnetQuote(options: {
  key: string;
  user: string;
  token: string;
  amount: string;
  recipient: string;
  depositAddress: string;
  now?: Date;
}): { payload: string; signature: string } {
  const { key, user, token, amount, recipient, depositAddress } = options;
  const now = options.now ?? new Date();
  const fields = {
    amount,
    amountIn: amount,
    depositAddress,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId,
    dry: false,
    originAsset: `nep141:${token}`,
    recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: user,
    refundType: "ORIGIN_CHAIN",
    slippageTolerance: MAX_QUOTE_SLIPPAGE_BPS,
    swapType: "EXACT_INPUT",
    timestamp: new Date(now.getTime() - 2_000).toISOString(),
  };
  const payload = JSON.stringify(fields);
  const seed = base58.decode(key.replace(/^ed25519:/, "")).slice(0, 32);
  const message = new TextEncoder().encode(base58.encode(sha256(new TextEncoder().encode(payload))));
  return { payload, signature: `ed25519:${base58.encode(ed25519.sign(message, seed))}` };
}
