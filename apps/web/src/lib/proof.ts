import type { Network } from "./config";

/**
 * The vault refusing a hacked keeper's rescue on chain: the keeper's own restricted key
 * called `rescue` with the user's real address and a correctly signed quote, but its own
 * account as where the money goes. A copy of scripts/attack-proof-testnet.json, held equal
 * to it by a test; `pnpm demo:attack` re-checks it on a public node.
 */
export const REFUSED_RESCUE: {
  network: Network;
  txHash: string;
  signer: string;
  vault: string;
  method: string;
  panic: string;
  at: string;
} = {
  network: "testnet",
  txHash: "A9QZC5bVA1iQUo2CEhksRNFvj77951GrmmJq835joKCn",
  signer: "keeper.lifeline-team.testnet",
  vault: "vault.lifeline-team.testnet",
  method: "rescue",
  panic: "BAD_QUOTE: its deposit address isn't the one this rescue pays",
  at: "2026-11-08T14:35:50.734Z",
};
