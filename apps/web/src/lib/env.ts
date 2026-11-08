import { readConfig } from "./config";

// Next inlines NEXT_PUBLIC_* values at build time only where they are written out in
// full, so each one is named here rather than read from process.env as a whole.
export const config = readConfig({
  NEXT_PUBLIC_KEEPER_API_URL: process.env.NEXT_PUBLIC_KEEPER_API_URL,
  NEXT_PUBLIC_SIM_KEEPER_API_URL: process.env.NEXT_PUBLIC_SIM_KEEPER_API_URL,
  NEXT_PUBLIC_NEAR_NETWORK: process.env.NEXT_PUBLIC_NEAR_NETWORK,
  NEXT_PUBLIC_NEAR_RPC_URL: process.env.NEXT_PUBLIC_NEAR_RPC_URL,
  NEXT_PUBLIC_VAULT_ID: process.env.NEXT_PUBLIC_VAULT_ID,
  NEXT_PUBLIC_KEEPER_ACCOUNT_ID: process.env.NEXT_PUBLIC_KEEPER_ACCOUNT_ID,
  NEXT_PUBLIC_USDC_CONTRACT_ID: process.env.NEXT_PUBLIC_USDC_CONTRACT_ID,
});
