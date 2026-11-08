export type Mode = "sim" | "live";

export const DEFAULT_NEAR_AI_URL = "https://cloud-api.near.ai/v1";
/** A private model, so it runs in a TEE and can be attested. Picked from /v1/models on 2026-11-06. */
export const DEFAULT_NEAR_AI_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

export type LiveConfig = {
  network: "testnet" | "mainnet";
  rpcUrl: string;
  vaultId: string;
  keeperAccountId: string;
  keeperKey: string;
  users: string[];
  oneClickUrl: string;
  oneClickJwt: string | undefined;
  port: number;
  dbPath: string;
  corsOrigin: string;
  dashboardUrl: string;
  botUsername: string | null;
  botToken: string | null;
  nearAiUrl: string;
  nearAiModel: string;
  nearAiKey: string | null;
};

type Env = Record<string, string | undefined>;

const USAGE = "usage: keeper --sim | --live";
const REQUIRED = ["NEAR_NETWORK", "NEAR_RPC_URL", "VAULT_CONTRACT_ID", "KEEPER_ACCOUNT_ID", "KEEPER_PRIVATE_KEY", "KEEPER_USERS"];
const ACCOUNT_SUFFIX = { testnet: ".testnet", mainnet: ".near" } as const;

export function parseMode(argv: string[]): Mode {
  if (argv.length === 1 && argv[0] === "--sim") return "sim";
  if (argv.length === 1 && argv[0] === "--live") return "live";
  throw new Error(USAGE);
}

const optional = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);

export type ServiceSettings = Pick<
  LiveConfig,
  "oneClickUrl" | "oneClickJwt" | "corsOrigin" | "dashboardUrl" | "botUsername" | "botToken" | "nearAiUrl" | "nearAiModel" | "nearAiKey"
>;

/** What --live and the hosted sim both use: 1Click, the dashboard, the Telegram bot and NEAR AI. */
export function readServiceSettings(env: Env): ServiceSettings {
  const botToken = optional(env.TELEGRAM_BOT_TOKEN) ?? null;
  // No token means no bot, so the API mustn't hand out codes for one.
  const botUsername = botToken === null ? null : (optional(env.TELEGRAM_BOT_USERNAME) ?? null);
  if (botToken !== null && botUsername === null) throw new Error("TELEGRAM_BOT_TOKEN also needs TELEGRAM_BOT_USERNAME");
  if (botToken !== null && optional(env.DASHBOARD_URL) === undefined) {
    throw new Error("TELEGRAM_BOT_TOKEN also needs DASHBOARD_URL, or /pause would link people to localhost");
  }
  return {
    oneClickUrl: optional(env.ONECLICK_API_URL) ?? "https://1click.chaindefuser.com",
    oneClickJwt: optional(env.ONECLICK_JWT),
    corsOrigin: optional(env.DASHBOARD_URL) ?? "*",
    dashboardUrl: optional(env.DASHBOARD_URL) ?? "http://localhost:3000",
    botUsername,
    botToken,
    nearAiUrl: optional(env.NEAR_AI_BASE_URL) ?? DEFAULT_NEAR_AI_URL,
    nearAiModel: optional(env.NEAR_AI_MODEL) ?? DEFAULT_NEAR_AI_MODEL,
    nearAiKey: optional(env.NEAR_AI_API_KEY) ?? null,
  };
}

/**
 * Reads --live's settings. Mainnet moves real money, so it needs its own explicit
 * yes, and every account must belong to the network named. Errors name settings,
 * never their values, because one of them is the keeper's private key.
 */
export function readLiveConfig(env: Env): LiveConfig {
  const missing = REQUIRED.filter((name) => optional(env[name]) === undefined);
  if (missing.length > 0) throw new Error(`missing settings: ${missing.join(", ")}`);

  const network = env.NEAR_NETWORK;
  if (network !== "testnet" && network !== "mainnet") throw new Error("NEAR_NETWORK must be testnet or mainnet");
  if (network === "mainnet" && env.KEEPER_ALLOW_MAINNET !== "yes") {
    throw new Error("mainnet moves real money: set KEEPER_ALLOW_MAINNET=yes only once a human has agreed");
  }

  const vaultId = env.VAULT_CONTRACT_ID as string;
  const keeperAccountId = env.KEEPER_ACCOUNT_ID as string;
  const users = (env.KEEPER_USERS as string)
    .split(",")
    .map((user) => user.trim())
    .filter((user) => user !== "");
  const suffix = ACCOUNT_SUFFIX[network];
  for (const account of [vaultId, keeperAccountId, ...users]) {
    if (!account.endsWith(suffix)) throw new Error(`${account} isn't a ${network} account: it must end in ${suffix}`);
  }

  const service = readServiceSettings(env);
  const rawPort = optional(env.KEEPER_PORT) ?? "8787";
  if (!/^\d+$/.test(rawPort)) throw new Error("KEEPER_PORT must be a number");

  return {
    network,
    rpcUrl: env.NEAR_RPC_URL as string,
    vaultId,
    keeperAccountId,
    keeperKey: env.KEEPER_PRIVATE_KEY as string,
    users,
    port: Number(rawPort),
    dbPath: optional(env.KEEPER_DB_PATH) ?? "./data/keeper.sqlite",
    ...service,
  };
}
