import { ASSETS } from "@lifeline/shared";

export type Network = "mainnet" | "testnet";

export type WebConfig = {
  /** The keeper whose REST API the dashboard reads for real accounts. */
  keeperApiUrl: string;
  /** The always-on sim keeper, used for the no-wallet demo whatever keeperApiUrl is. */
  simKeeperApiUrl: string;
  network: Network;
  rpcUrl: string;
  /** null until the vault is deployed: the UI says so and keeps everything else working. */
  vaultId: string | null;
  /** The keeper account a new policy names. null means set_policy can't be signed yet. */
  keeperAccountId: string | null;
  usdcContractId: string;
};

export const SIM_KEEPER_URL = "https://lifeline-sim.prashantthakur.dev";
/** The account the hosted sim watches. */
export const DEMO_USER = "demo.near";

/** From https://docs.near.org/api/rpc/providers, as in the repo's .env.example. */
export const DEFAULT_RPC_URL: Record<Network, string> = {
  mainnet: "https://free.rpc.fastnear.com",
  testnet: "https://test.rpc.fastnear.com",
};

type Env = Record<string, string | undefined>;

const clean = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "");

/** Reads the NEXT_PUBLIC_* settings, with the defaults the hosted dashboard uses. */
export function readConfig(env: Env): WebConfig {
  const networkValue = clean(env.NEXT_PUBLIC_NEAR_NETWORK);
  if (networkValue !== null && networkValue !== "mainnet" && networkValue !== "testnet") {
    throw new Error(`NEXT_PUBLIC_NEAR_NETWORK must be mainnet or testnet, not ${networkValue}`);
  }
  const network: Network = networkValue ?? "mainnet";
  return {
    keeperApiUrl: withoutTrailingSlash(clean(env.NEXT_PUBLIC_KEEPER_API_URL) ?? SIM_KEEPER_URL),
    simKeeperApiUrl: withoutTrailingSlash(clean(env.NEXT_PUBLIC_SIM_KEEPER_API_URL) ?? SIM_KEEPER_URL),
    network,
    rpcUrl: withoutTrailingSlash(clean(env.NEXT_PUBLIC_NEAR_RPC_URL) ?? DEFAULT_RPC_URL[network]),
    vaultId: clean(env.NEXT_PUBLIC_VAULT_ID),
    keeperAccountId: clean(env.NEXT_PUBLIC_KEEPER_ACCOUNT_ID),
    usdcContractId: clean(env.NEXT_PUBLIC_USDC_CONTRACT_ID) ?? ASSETS.NEAR_USDC.contractId,
  };
}

/** Which keeper holds this account's data: the demo account always lives on the sim. */
export function keeperUrlFor(config: Pick<WebConfig, "keeperApiUrl" | "simKeeperApiUrl">, user: string): string {
  return user === DEMO_USER ? config.simKeeperApiUrl : config.keeperApiUrl;
}
