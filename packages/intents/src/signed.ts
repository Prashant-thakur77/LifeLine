import type { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import stringify from "json-stable-stringify";

type RawQuote = Parameters<typeof verifyQuoteSignature>[0];
type Fields = Record<string, unknown>;

/** Empty values are left out, as 1Click leaves them out before signing. */
const present = (value: unknown) => (value ? value : undefined);

/**
 * The exact text 1Click signs: the request and quote fields it covers, plus the timestamp,
 * as stable (sorted-key) JSON. Its base58 SHA-256 is the SDK's quoteHash, and a test holds
 * the two equal on real quotes. The vault gets this text with the signature, checks the
 * signature itself, and reads the deposit address, recipient and amount from it, so a
 * keeper can't send money anywhere 1Click didn't quote.
 */
export function signedQuotePayload(raw: RawQuote): string {
  const request = raw.quoteRequest as unknown as Fields;
  const quote = raw.quote as unknown as Fields;
  const signedRequest = {
    dry: request.dry,
    swapType: request.swapType,
    slippageTolerance: request.slippageTolerance,
    originAsset: request.originAsset,
    depositType: request.depositType,
    destinationAsset: request.destinationAsset,
    amount: request.amount,
    refundTo: request.refundTo,
    refundType: request.refundType,
    recipient: request.recipient,
    recipientType: request.recipientType,
    deadline: request.deadline,
    quoteWaitingTimeMs: present(request.quoteWaitingTimeMs),
    referral: present(request.referral),
    virtualChainRecipient: present(request.virtualChainRecipient),
    virtualChainRefundRecipient: present(request.virtualChainRefundRecipient),
    customRecipientMsg: present(request.customRecipientMsg),
  };
  const amounts = {
    amountIn: quote.amountIn,
    amountInFormatted: quote.amountInFormatted,
    amountInUsd: quote.amountInUsd,
    minAmountIn: quote.minAmountIn,
    amountOut: quote.amountOut,
    amountOutFormatted: quote.amountOutFormatted,
    amountOutUsd: quote.amountOutUsd,
    minAmountOut: quote.minAmountOut,
  };
  const signedQuote = request.dry
    ? amounts
    : {
        ...amounts,
        depositAddress: present(quote.depositAddress),
        depositMemo: present(quote.depositMemo),
        deadline: present(quote.deadline),
        timeWhenInactive: present(quote.timeWhenInactive),
        timeEstimate: present(quote.timeEstimate),
        refundFee: present(quote.refundFee),
        withdrawFee: present(quote.withdrawFee),
      };
  return stringify({ ...signedRequest, ...signedQuote, timestamp: raw.timestamp }) as string;
}
