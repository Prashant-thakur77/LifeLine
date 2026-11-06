import { describe, expect, it } from "vitest";
import { parseMode, readLiveConfig } from "../src/config";

const env = {
  NEAR_NETWORK: "testnet",
  NEAR_RPC_URL: "https://test.rpc.fastnear.com",
  VAULT_CONTRACT_ID: "vault.team.testnet",
  KEEPER_ACCOUNT_ID: "keeper.team.testnet",
  KEEPER_PRIVATE_KEY: "ed25519:secret-value",
  KEEPER_USERS: "alice.testnet, bob.testnet",
};

describe("parseMode", () => {
  it("reads --sim and --live", () => {
    expect(parseMode(["--sim"])).toBe("sim");
    expect(parseMode(["--live"])).toBe("live");
  });

  it.each([[[]], [["--sim", "--live"]], [["--nope"]]])("refuses %j", (argv) => {
    expect(() => parseMode(argv as string[])).toThrow(/usage/i);
  });
});

describe("readLiveConfig", () => {
  it("reads a testnet setup, with sensible defaults", () => {
    expect(readLiveConfig(env)).toEqual({
      network: "testnet",
      rpcUrl: env.NEAR_RPC_URL,
      vaultId: env.VAULT_CONTRACT_ID,
      keeperAccountId: env.KEEPER_ACCOUNT_ID,
      keeperKey: env.KEEPER_PRIVATE_KEY,
      users: ["alice.testnet", "bob.testnet"],
      oneClickUrl: "https://1click.chaindefuser.com",
      oneClickJwt: undefined,
      port: 8787,
      dbPath: "./data/keeper.sqlite",
      corsOrigin: "*",
      dashboardUrl: "http://localhost:3000",
      botUsername: null,
      botToken: null,
      nearAiUrl: "https://cloud-api.near.ai/v1",
      nearAiModel: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      nearAiKey: null,
    });
  });

  it("names every missing setting at once, and never prints a value", () => {
    let message = "";
    try {
      readLiveConfig({ KEEPER_PRIVATE_KEY: "ed25519:secret-value", NEAR_NETWORK: "testnet" });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of ["NEAR_RPC_URL", "VAULT_CONTRACT_ID", "KEEPER_ACCOUNT_ID", "KEEPER_USERS"]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain("secret-value");
  });

  it("refuses mainnet unless a human has explicitly allowed it", () => {
    const mainnet = {
      ...env,
      NEAR_NETWORK: "mainnet",
      VAULT_CONTRACT_ID: "vault.team.near",
      KEEPER_ACCOUNT_ID: "keeper.team.near",
      KEEPER_USERS: "alice.near",
    };
    expect(() => readLiveConfig(mainnet)).toThrow(/KEEPER_ALLOW_MAINNET/);
    expect(() => readLiveConfig({ ...mainnet, KEEPER_ALLOW_MAINNET: "true" })).toThrow(/KEEPER_ALLOW_MAINNET/);
    expect(readLiveConfig({ ...mainnet, KEEPER_ALLOW_MAINNET: "yes" }).network).toBe("mainnet");
  });

  it("refuses a testnet setting that points at a mainnet account", () => {
    expect(() => readLiveConfig({ ...env, VAULT_CONTRACT_ID: "vault.team.near" })).toThrow(/testnet/);
    expect(() => readLiveConfig({ ...env, KEEPER_ACCOUNT_ID: "keeper.team.near" })).toThrow(/testnet/);
  });

  it("refuses a network it doesn't know", () => {
    expect(() => readLiveConfig({ ...env, NEAR_NETWORK: "betanet" })).toThrow(/NEAR_NETWORK/);
  });

  it("refuses a bad port", () => {
    expect(() => readLiveConfig({ ...env, KEEPER_PORT: "abc" })).toThrow(/KEEPER_PORT/);
  });

  it("needs the bot's username alongside its token, because the API hands it out", () => {
    const withDashboard = { ...env, DASHBOARD_URL: "https://lifeline.example", TELEGRAM_BOT_TOKEN: "1:secret-token" };
    expect(() => readLiveConfig(withDashboard)).toThrow(/TELEGRAM_BOT_USERNAME/);
    const config = readLiveConfig({ ...withDashboard, TELEGRAM_BOT_USERNAME: "lifeline_bot" });
    expect(config.botToken).toBe("1:secret-token");
  });

  it("needs the dashboard's address with a bot, or /pause would link people to localhost", () => {
    expect(() => readLiveConfig({ ...env, TELEGRAM_BOT_TOKEN: "1:secret-token", TELEGRAM_BOT_USERNAME: "lifeline_bot" })).toThrow(/DASHBOARD_URL/);
  });

  it("doesn't hand out link codes for a bot that isn't running", () => {
    expect(readLiveConfig({ ...env, TELEGRAM_BOT_USERNAME: "lifeline_bot" }).botUsername).toBeNull();
  });

  it("doesn't print the bot's token in that error", () => {
    let message = "";
    try {
      readLiveConfig({ ...env, TELEGRAM_BOT_TOKEN: "1:secret-token" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("secret-token");
  });

  it("reads the NEAR AI settings", () => {
    const config = readLiveConfig({ ...env, NEAR_AI_BASE_URL: "https://near-ai.test/v1", NEAR_AI_MODEL: "some/model", NEAR_AI_API_KEY: "key" });
    expect(config).toMatchObject({ nearAiUrl: "https://near-ai.test/v1", nearAiModel: "some/model", nearAiKey: "key" });
  });

  it("reads the NEAR AI settings", () => {
    const config = readLiveConfig({ ...env, NEAR_AI_BASE_URL: "https://near-ai.test/v1", NEAR_AI_MODEL: "some/model", NEAR_AI_API_KEY: "key" });
    expect(config).toMatchObject({ nearAiUrl: "https://near-ai.test/v1", nearAiModel: "some/model", nearAiKey: "key" });
  });

  it("treats blank optional settings as unset", () => {
    const config = readLiveConfig({ ...env, ONECLICK_JWT: "", TELEGRAM_BOT_USERNAME: " ", DASHBOARD_URL: "" });
    expect(config.oneClickJwt).toBeUndefined();
    expect(config.botUsername).toBeNull();
    expect(config.corsOrigin).toBe("*");
  });

  it("passes the optional settings through", () => {
    const config = readLiveConfig({
      ...env,
      ONECLICK_JWT: "jwt",
      TELEGRAM_BOT_TOKEN: "1:secret-token",
      TELEGRAM_BOT_USERNAME: "lifeline_bot",
      DASHBOARD_URL: "https://lifeline.example",
      KEEPER_PORT: "9000",
      KEEPER_DB_PATH: "/data/k.sqlite",
    });
    expect(config).toMatchObject({
      oneClickJwt: "jwt",
      botUsername: "lifeline_bot",
      corsOrigin: "https://lifeline.example",
      port: 9000,
      dbPath: "/data/k.sqlite",
    });
  });
});
