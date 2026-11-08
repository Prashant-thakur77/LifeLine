import { viewFunction } from "./near-rpc";
import type { VaultPolicyInput, VaultPolicyView } from "./policy";

// The vault's interface, from contracts/vault/README.md. Deposits are what each method
// requires: 1 yoctoNEAR can only be attached by a full-access key, so the wallet always
// asks the user to confirm a policy change, an unpause, a deposit or a withdrawal.

export const ONE_YOCTO = "1";
/** 0.05 NEAR, for the user's storage in the vault, the first time they set a policy. */
export const REGISTRATION_DEPOSIT = "50000000000000000000000";
const TGAS = 1_000_000_000_000n;
const gas = (tgas: number) => (BigInt(tgas) * TGAS).toString();

/** The action shape near-connect's signAndSendTransaction takes. */
export type FunctionCall = {
  type: "FunctionCall";
  params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
};

export type Transaction = { receiverId: string; actions: FunctionCall[] };

const call = (receiverId: string, methodName: string, args: Record<string, unknown>, tgas: number, deposit: string): Transaction => ({
  receiverId,
  actions: [{ type: "FunctionCall", params: { methodName, args, gas: gas(tgas), deposit } }],
});

/** set_policy: 0.05 NEAR when the user has no policy yet, 1 yoctoNEAR after. */
export const setPolicyTx = (vaultId: string, policy: VaultPolicyInput, firstTime: boolean): Transaction =>
  call(vaultId, "set_policy", { policy }, 30, firstTime ? REGISTRATION_DEPOSIT : ONE_YOCTO);

/** pause needs no deposit, so any key the user's wallet holds can stop rescues at once. */
export const pauseTx = (vaultId: string): Transaction => call(vaultId, "pause", {}, 10, "0");

export const unpauseTx = (vaultId: string): Transaction => call(vaultId, "unpause", {}, 10, ONE_YOCTO);

export const withdrawTx = (vaultId: string, token: string, amount: string): Transaction =>
  call(vaultId, "withdraw", { token, amount }, 50, ONE_YOCTO);

/** Moves USDC from the user's account into their reserve: ft_transfer_call on the token, msg "". */
export const depositTx = (tokenId: string, vaultId: string, amount: string): Transaction =>
  call(tokenId, "ft_transfer_call", { receiver_id: vaultId, amount, msg: "" }, 100, ONE_YOCTO);

/** Registers an account with a token (NEP-145), so the token can be sent to it. */
export const registerTokenTx = (tokenId: string, accountId: string, deposit: string): Transaction =>
  call(tokenId, "storage_deposit", { account_id: accountId, registration_only: true }, 30, deposit);

export type RescueView = {
  token: string;
  amount: string;
  at: string; // nanoseconds since the epoch
  quote_id: string;
  deposit_address: string;
  recipient: string;
  refunded: boolean;
};

/** Nanoseconds since the epoch, as the vault stores time, to an ISO string. */
export function nsToIso(ns: string): string | null {
  if (!/^\d+$/.test(ns)) return null;
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
}

export const vaultViews = {
  policy: (rpc: string, vault: string, user: string) => viewFunction<VaultPolicyView | null>(rpc, vault, "get_policy", { user }),
  reserve: (rpc: string, vault: string, user: string) => viewFunction<Record<string, string>>(rpc, vault, "get_reserve", { user }),
  rescues: (rpc: string, vault: string, user: string, from = 0, limit = 100) =>
    viewFunction<RescueView[]>(rpc, vault, "get_rescues", { user, from, limit }),
  tokens: (rpc: string, vault: string) => viewFunction<string[]>(rpc, vault, "get_tokens"),
};

export const tokenViews = {
  balance: (rpc: string, token: string, accountId: string) => viewFunction<string>(rpc, token, "ft_balance_of", { account_id: accountId }),
  storageBalance: (rpc: string, token: string, accountId: string) =>
    viewFunction<{ total: string; available: string } | null>(rpc, token, "storage_balance_of", { account_id: accountId }),
  storageBounds: (rpc: string, token: string) => viewFunction<{ min: string; max: string | null }>(rpc, token, "storage_balance_bounds"),
};
