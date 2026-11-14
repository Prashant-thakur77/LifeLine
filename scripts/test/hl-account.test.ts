import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { HL_DOMAIN, USER_SET_ABSTRACTION, addressOf, recoverAddress, signDigest, typedDataDigest, userSignedAction } from "../src/hl-account";

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

describe("Hyperliquid's user-signed envelope", () => {
  it("adds signatureChainId 0x66eee and Mainnet, signs over the SDK's domain, and recovers to the signer", () => {
    const signed = userSignedAction("HyperliquidTransaction:UserSetAbstraction", USER_SET_ABSTRACTION, { type: "userSetAbstraction", user: addressOf(COW), abstraction: "disabled", nonce: 1 }, COW);
    expect(signed.action).toMatchObject({ signatureChainId: "0x66eee", hyperliquidChain: "Mainnet", abstraction: "disabled" });
    expect(HL_DOMAIN).toEqual({ name: "HyperliquidSignTransaction", version: "1", chainId: 421614, verifyingContract: "0x0000000000000000000000000000000000000000" });
    expect(recoverAddress(signed.digest, signed.signature)).toBe(addressOf(COW));
  });
});
