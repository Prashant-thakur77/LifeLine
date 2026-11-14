import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { HL_DOMAIN, USER_SET_ABSTRACTION, addressOf, perpPrice, recoverAddress, signDigest, signL1Action, typedDataDigest, userSignedAction } from "../src/hl-account";

// The example from the EIP-712 specification (eips.ethereum.org/EIPS/eip-712), with its published digest and signature.
const MAIL_TYPES = {
  Person: [
    { name: "name", type: "string" },
    { name: "wallet", type: "address" },
  ],
  Mail: [
    { name: "from", type: "Person" },
    { name: "to", type: "Person" },
    { name: "contents", type: "string" },
  ],
};
const MAIL_DOMAIN = { name: "Ether Mail", version: "1", chainId: 1, verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" };
const MAIL = {
  from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
  to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
  contents: "Hello, Bob!",
};
const COW = keccak_256(new TextEncoder().encode("cow"));

describe("EIP-712, held to the specification's own example", () => {
  it("gives the spec's digest", () => {
    expect(bytesToHex(typedDataDigest(MAIL_DOMAIN, "Mail", MAIL_TYPES, MAIL))).toBe("be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2");
  });

  it("signs it as the spec does with the key keccak256('cow'), and recovers that address", () => {
    expect(addressOf(COW)).toBe("0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826");
    const sig = signDigest(typedDataDigest(MAIL_DOMAIN, "Mail", MAIL_TYPES, MAIL), COW);
    expect(sig).toEqual({
      r: "0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d",
      s: "0x07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b91562",
      v: 28,
    });
    expect(recoverAddress(typedDataDigest(MAIL_DOMAIN, "Mail", MAIL_TYPES, MAIL), sig)).toBe(addressOf(COW));
  });
});

describe("Hyperliquid's L1 action signature, held to its SDK's own test vectors (tests/signing_test.py)", () => {
  const SDK_KEY = hexToBytes("0123456789012345678901234567890123456789012345678901234567890123");
  const asBig = (hex: string) => BigInt(hex);

  it("signs the SDK's dummy action as the SDK does, on mainnet", () => {
    const { signature } = signL1Action({ type: "dummy", num: 100_000_000_000 }, 0, SDK_KEY);
    expect(asBig(signature.r)).toBe(asBig("0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298"));
    expect(asBig(signature.s)).toBe(asBig("0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8"));
    expect(signature.v).toBe(27);
  });

  it("signs the SDK's order as the SDK does, on mainnet and testnet", () => {
    const order = { type: "order", orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" };
    const main = signL1Action(order, 0, SDK_KEY).signature;
    expect(asBig(main.r)).toBe(asBig("0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e"));
    expect(asBig(main.s)).toBe(asBig("0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e"));
    expect(main.v).toBe(28);
    const test = signL1Action(order, 0, SDK_KEY, false).signature;
    expect(asBig(test.r)).toBe(asBig("0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54"));
    expect(test.v).toBe(27);
  });

  it("prices a perp order at 5 significant figures and 6 − szDecimals decimals", () => {
    expect(perpPrice(502.13337, 3)).toBe("502.13");
    expect(perpPrice(67400.4, 5)).toBe("67400");
    expect(perpPrice(1.234567, 0)).toBe("1.2346");
  });
});

describe("Hyperliquid's user-signed envelope", () => {
  it("adds signatureChainId 0x66eee and Mainnet, signs over the SDK's domain, and recovers to the signer", () => {
    const signed = userSignedAction("HyperliquidTransaction:UserSetAbstraction", USER_SET_ABSTRACTION, { type: "userSetAbstraction", user: addressOf(COW), abstraction: "disabled", nonce: 1 }, COW);
    expect(signed.action).toMatchObject({ signatureChainId: "0x66eee", hyperliquidChain: "Mainnet", abstraction: "disabled" });
    expect(HL_DOMAIN).toEqual({ name: "HyperliquidSignTransaction", version: "1", chainId: 421614, verifyingContract: "0x0000000000000000000000000000000000000000" });
    expect(recoverAddress(signed.digest, signed.signature)).toBe(addressOf(COW));
  });
});
