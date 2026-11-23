import { PORTFOLIO_LIQUIDATION_RATIO, healthAfter, parseAgents, readAccountRisk, stopsFor, storm, suggestPlan, worseDirection, type AccountRisk, type InfoReader } from "@lifeline/hyperliquid";
import { ASSETS, POLICY_DEFAULTS, POLICY_RANGES } from "@lifeline/shared";
import type { Args, InputSchema } from "./schema";

export type Network = "testnet" | "mainnet";
/** A vault view, or null when the vault says there's nothing there. Throws when it can't be read. */
export type VaultReader = (network: Network, method: string, args: Record<string, unknown>) => Promise<unknown>;
export type KeeperReader = (path: string) => Promise<unknown>;
export type ToolDeps = { info: InfoReader; vault: VaultReader; keeper: KeeperReader; now: () => Date };

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  run: (args: Args, deps: ToolDeps) => Promise<Record<string, unknown>>;
};

/** Something the caller can act on. Anything else that's thrown is never shown to a model. */
export class ToolError extends Error {}

export const DEPLOYED: Record<Network, { vault: string; keeper: string; usdc: string; rpc: string }> = {
  testnet: { vault: "vault.lifeline-team.testnet", keeper: "keeper.lifeline-team.testnet", usdc: "usdc.lifeline-team.testnet", rpc: "https://test.rpc.fastnear.com" },
  mainnet: { vault: "vault.lifeline-hq.near", keeper: "keeper.lifeline-hq.near", usdc: ASSETS.NEAR_USDC.contractId, rpc: "https://free.rpc.fastnear.com" },
};
export const SITE = "https://lifeline.prashantthakur.dev";
const FLAT_FEE_USD = 0.3153; // 1Click's, measured on 2026-11-06

const HL = "^0x[0-9a-fA-F]{40}$";
const NEAR = "^(?=.{2,64}$)(([a-z0-9]+[-_])*[a-z0-9]+\\.)*([a-z0-9]+[-_])*[a-z0-9]+$";
const hlAddress = { type: "string", pattern: HL, description: "A Hyperliquid address: 0x and 40 hex characters" } as const;
const account = { type: "string", pattern: NEAR, description: "The user's NEAR account" } as const;
const network = { type: "string", enum: ["testnet", "mainnet"], description: "Which NEAR network" } as const;
const usd = (description: string) => ({ type: "number", minimum: 0, maximum: 1_000_000_000, description }) as const;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const round = (n: number, places = 4) => (Number.isFinite(n) ? Number(n.toFixed(places)) : null);
const usdc = (units: unknown) => (typeof units === "string" && /^\d+$/.test(units) ? Number(units) / 1e6 : null);

/** A coin's name comes from whoever listed the market, so only a plain one is passed on. */
const coinName = (coin: string) => (/^[A-Za-z0-9:_@./-]{1,32}$/.test(coin) ? coin : "unnamed");

async function readRisk(address: string, deps: ToolDeps): Promise<AccountRisk> {
  try {
    return await readAccountRisk(address, deps.info);
  } catch {
    throw new ToolError("Hyperliquid's reading of this account couldn't be used. Treat its health as unknown, never as safe.");
  }
}

const described = (risk: AccountRisk) => ({
  marginMode: risk.mode,
  health: risk.mode === "portfolio" ? null : round(risk.health),
  noPositions: risk.mode !== "portfolio" && risk.health === Number.POSITIVE_INFINITY,
  valueUsd: round(risk.value, 2),
  maintenanceUsd: round(risk.maintenance, 2),
  portfolioMarginRatio: risk.portfolioRatio,
  liquidatesAt: risk.mode === "portfolio" ? `portfolioMarginRatio above ${PORTFOLIO_LIQUIDATION_RATIO}` : "health 1.0",
  marketsNotRead: risk.unread.map(coinName),
});

type Warning = { code: string; severity: "error" | "warning"; message: string };
const warning = (code: string, severity: Warning["severity"], message: string): Warning => ({ code, severity, message });

const YOCTO = "1";
const REGISTRATION = "50000000000000000000000"; // 0.05 NEAR, for the user's storage, the first time
const tgas = (n: number) => `${n}000000000000`;

/** What the wallet is asked to sign, with nothing filled in by free text. */
const unsigned = (deps: ToolDeps, net: Network, signer: string, method: string, args: Record<string, unknown>, gas: number, deposit: string, summary: string, warnings: Warning[], reviewUrl: string) => ({
  network: net,
  signed: false,
  blocked: warnings.some((w) => w.severity === "error"),
  summary,
  warnings,
  transaction: { signerId: signer, receiverId: DEPLOYED[net].vault, actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: tgas(gas), deposit } }] },
  reviewUrl,
  preparedAt: deps.now().toISOString(),
  next: "Show the summary and every warning to the user. Only they can sign it, in their own wallet. Never ask for a private key or seed phrase.",
});

async function view<T>(deps: ToolDeps, net: Network, method: string, args: Record<string, unknown>): Promise<T> {
  try {
    return (await deps.vault(net, method, args)) as T;
  } catch {
    throw new ToolError(`The vault on ${net} couldn't be read. Try again in a moment.`);
  }
}

type PolicyView = { hl_address: string; keeper: string; warn: number; trigger: number; target: number; max_per_rescue: string; max_per_day: string; cooldown_sec: number; paused: boolean };

const describePolicy = (p: PolicyView) => ({
  hlAddress: p.hl_address,
  keeper: p.keeper,
  warn: p.warn,
  trigger: p.trigger,
  target: p.target,
  maxPerRescueUsdc: usdc(p.max_per_rescue),
  maxPerDayUsdc: usdc(p.max_per_day),
  cooldownSec: p.cooldown_sec,
  paused: p.paused,
});

/** Each refusal the vault gives, in words (contracts/vault/README.md). */
export const REFUSALS: Record<string, string> = {
  BAD_QUOTE: "The quote isn't signed by 1Click, or it doesn't pay what the rescue says: the deposit address, the amount, the user's own Hyperliquid address and a refund to the user.",
  RECIPIENT_MISMATCH: "The rescue names a different Hyperliquid address from the one in the user's policy.",
  OVER_PER_RESCUE: "The amount is above the user's cap for one rescue.",
  OVER_DAILY: "The last 24 hours of rescues plus this one would pass the user's daily cap.",
  COOLDOWN: "The last rescue was too recent for the user's cooldown.",
  NOT_KEEPER: "The caller isn't the keeper named in the user's policy.",
  PAUSED: "The user has paused rescues.",
  BAD_QUOTE_ID: "The quote's id is missing or too long.",
  DEPOSIT_REUSED: "That deposit address has been paid before; each one works once.",
  NO_POLICY: "The user has never set a policy.",
  UNKNOWN_TOKEN: "The vault doesn't hold that token.",
  INSUFFICIENT_RESERVE: "The user's reserve doesn't hold that much.",
};

export const TOOLS: Tool[] = [
  {
    name: "check_account",
    title: "Check a Hyperliquid account",
    description: "Reads any Hyperliquid account's margin health live, in its own margin mode, and lists its positions, which of them a top-up can reach, which have a stop, and how many API keys can trade it. Read only.",
    inputSchema: { type: "object", properties: { address: hlAddress }, required: ["address"], additionalProperties: false },
    annotations: { title: "Check a Hyperliquid account", ...READ },
    run: async ({ address }, deps) => {
      const user = String(address);
      const risk = await readRisk(user, deps);
      const all = [...risk.covered, ...risk.uncovered];
      const or = (work: Promise<unknown>) => work.catch(() => null);
      const dexes = [...new Set(all.map((p) => p.dex))];
      const [agents, ...orders] = await Promise.all([or(deps.info({ type: "extraAgents", user })), ...dexes.map((dex) => or(deps.info({ type: "frontendOpenOrders", user, ...(dex ? { dex } : {}) })))]);
      const stops = orders.every(Array.isArray) ? stopsFor(all, orders.flat()) : null;
      const keys = parseAgents(agents);
      return {
        source: "Hyperliquid mainnet, live",
        asOf: deps.now().toISOString(),
        ...described(risk),
        keeperHealth: risk.keeperHealth === null ? null : round(risk.keeperHealth),
        positions: all.slice(0, 100).map((p, i) => ({ coin: coinName(p.coin), side: p.size > 0 ? "long" : "short", size: Math.abs(p.size), markPx: p.markPx, liquidationPx: p.liquidationPx, topUpReaches: risk.covered.includes(p), hasStop: stops?.[i]?.hasStop ?? null })),
        positionsTotal: all.length,
        tradingKeys: keys === null ? null : keys.filter((k) => k.validUntil === null || k.validUntil > deps.now().getTime()).length,
      };
    },
  },
  {
    name: "storm_test",
    title: "Storm-test a Hyperliquid account",
    description: "Estimates the market move that liquidates an account, and how much further it lasts with Lifeline rescues from a given reserve. Optionally gives the health after one move, or moves a single coin. An estimate: coins keep their margin tier, no funding, and prices move slowly enough for each rescue to land.",
    inputSchema: {
      type: "object",
      properties: {
        address: hlAddress,
        move_pct: { type: "number", minimum: -90, maximum: 150, description: "A move to try, in percent. Negative is down." },
        coin: { type: "string", pattern: "^[A-Za-z0-9:_@./-]{1,32}$", description: "Move only this coin. Leave out to move everything." },
        reserve_usd: usd("What the vault reserve would hold, in USD"),
        per_rescue_usd: usd("Most to send in one rescue, in USD"),
        trigger: { type: "number", minimum: POLICY_RANGES.trigger.min, maximum: POLICY_RANGES.trigger.max, description: "Rescue below this health" },
        target: { type: "number", minimum: POLICY_RANGES.trigger.min, maximum: POLICY_RANGES.target.max, description: "Refill to this health" },
      },
      required: ["address"],
      additionalProperties: false,
    },
    annotations: { title: "Storm-test a Hyperliquid account", ...READ },
    run: async (args, deps) => {
      const risk = await readRisk(String(args.address), deps);
      if (risk.mode === "portfolio") throw new ToolError("This is a portfolio margin account. Lifeline's health number doesn't describe it, so there's no storm test. check_account gives its own ratio.");
      if (risk.covered.length === 0) throw new ToolError("This account has no cross positions, so there's nothing a top-up could protect.");
      const coin = args.coin === undefined ? null : String(args.coin);
      if (coin !== null && !risk.covered.some((p) => p.coin === coin)) throw new ToolError("This account has no cross position in that coin.");
      const lines = { trigger: Number(args.trigger ?? POLICY_DEFAULTS.trigger), target: Number(args.target ?? POLICY_DEFAULTS.target) };
      if (!(lines.target > lines.trigger)) throw new ToolError("target must be above trigger.");
      const plan = suggestPlan(risk, lines, FLAT_FEE_USD);
      if (args.reserve_usd !== undefined) plan.reserveUsd = plan.perDayUsd = Number(args.reserve_usd);
      if (args.per_rescue_usd !== undefined) plan.perRescueUsd = Number(args.per_rescue_usd);
      const worse = worseDirection(risk, coin);
      const result = storm(risk, worse < 0 ? -90 : 150, plan, coin);
      const move = args.move_pct === undefined ? null : Number(args.move_pct);
      return {
        source: "Hyperliquid mainnet, live; the moves are estimates",
        asOf: deps.now().toISOString(),
        ...described(risk),
        moves: coin ?? "everything together",
        worseDirection: worse < 0 ? "down" : "up",
        liquidatedAtPct: result.diesWithout,
        liquidatedAtPctWithLifeline: result.diesWith,
        rescues: result.rescues.length,
        rescuedUsd: round(result.spentUsd, 2),
        plan,
        ...(move === null ? {} : { afterMove: { movePct: move, healthWithoutLifeline: round(healthAfter(risk, move, coin)) } }),
        note: "null means no move in the tested range (down 90%, up 150%) liquidates it. Topped-up money can still be lost.",
      };
    },
  },
  {
    name: "get_protection",
    title: "Read an account's Lifeline protection",
    description: "Reads a NEAR account's policy, reserve and rescue count straight from the vault contract. Read only.",
    inputSchema: { type: "object", properties: { account, network }, required: ["account", "network"], additionalProperties: false },
    annotations: { title: "Read an account's Lifeline protection", ...READ },
    run: async (args, deps) => {
      const net = args.network as Network;
      const user = String(args.account);
      const [policy, reserve, rescues] = await Promise.all([
        view<PolicyView | null>(deps, net, "get_policy", { user }),
        view<Record<string, string> | null>(deps, net, "get_reserve", { user }),
        view<number | null>(deps, net, "get_rescue_count", { user }),
      ]);
      return {
        source: `${DEPLOYED[net].vault} on NEAR ${net}`,
        asOf: deps.now().toISOString(),
        protected: policy !== null && !policy.paused && (usdc(reserve?.[DEPLOYED[net].usdc]) ?? 0) >= 2,
        policy: policy === null ? null : describePolicy(policy),
        reserveUsdc: usdc(reserve?.[DEPLOYED[net].usdc]) ?? 0,
        rescues: typeof rescues === "number" ? rescues : 0,
      };
    },
  },
  {
    name: "get_recent_decisions",
    title: "Read the demo keeper's decisions",
    description: "The public demo keeper's latest decisions: warnings, rescues and refusals with their reason codes. It is a simulation with real prices and quotes; no money moves.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, description: "How many, newest first (default 10)" } }, additionalProperties: false },
    annotations: { title: "Read the demo keeper's decisions", ...READ },
    run: async (args, deps) => {
      let records: unknown;
      try {
        records = await deps.keeper(`/api/ledger?limit=${Number(args.limit ?? 10)}`);
      } catch {
        records = null;
      }
      if (!Array.isArray(records)) throw new ToolError("The demo keeper didn't answer. Try again in a moment.");
      return {
        source: "lifeline-sim.prashantthakur.dev",
        mode: "simulation",
        asOf: deps.now().toISOString(),
        // Codes, numbers and times only: a record's written explanation comes from a model.
        decisions: records.map((r: Record<string, unknown>) => {
          const decision = r.decision as { reasons?: unknown } | undefined;
          const request = r.request as { amount?: unknown } | undefined;
          return {
            kind: typeof r.kind === "string" && /^[A-Z_]{1,32}$/.test(r.kind) ? r.kind : "UNKNOWN",
            reasons: Array.isArray(decision?.reasons) ? decision.reasons.filter((x): x is string => typeof x === "string" && /^[A-Z_]{1,32}$/.test(x)) : [],
            amountUsdc: usdc(request?.amount),
            healthBefore: typeof r.healthBefore === "number" ? round(r.healthBefore) : null,
            healthAfter: typeof r.healthAfter === "number" ? round(r.healthAfter) : null,
            at: typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at).toISOString() : null,
          };
        }),
      };
    },
  },
  {
    name: "explain_refusal",
    title: "Explain a vault refusal",
    description: "What one of the vault's refusal codes means.",
    inputSchema: { type: "object", properties: { code: { type: "string", enum: Object.keys(REFUSALS), description: "The code the vault answered" } }, required: ["code"], additionalProperties: false },
    annotations: { title: "Explain a vault refusal", ...READ, openWorldHint: false },
    run: async ({ code }) => ({ code: String(code), meaning: REFUSALS[String(code)]! }),
  },
  {
    name: "prepare_policy",
    title: "Prepare a protection policy",
    description: "Checks a policy against the vault's rules and returns an UNSIGNED set_policy transaction and a review link. It changes nothing: the user signs it in their own wallet, or not.",
    inputSchema: {
      type: "object",
      properties: {
        account,
        network,
        hl_address: { ...hlAddress, description: "The only Hyperliquid address the vault may ever pay" },
        warn: { type: "number", minimum: POLICY_RANGES.warn.min, maximum: POLICY_RANGES.warn.max, description: `Warn below this health (default ${POLICY_DEFAULTS.warn})` },
        trigger: { type: "number", minimum: POLICY_RANGES.trigger.min, maximum: POLICY_RANGES.trigger.max, description: `Rescue below this health (default ${POLICY_DEFAULTS.trigger})` },
        target: { type: "number", minimum: POLICY_RANGES.trigger.min, maximum: POLICY_RANGES.target.max, description: `Refill to this health (default ${POLICY_DEFAULTS.target})` },
        max_per_rescue_usdc: { type: "number", minimum: 2, maximum: 1_000_000, description: "Most in one rescue, in USDC (default 25; 1Click won't send less than 2)" },
        max_per_day_usdc: { type: "number", minimum: 2, maximum: 10_000_000, description: "Most in any 24 hours, in USDC (default 50)" },
        cooldown_sec: { type: "integer", minimum: POLICY_RANGES.cooldownSec.min, maximum: POLICY_RANGES.cooldownSec.max, description: "Seconds between rescues (default 120)" },
      },
      required: ["account", "network", "hl_address"],
      additionalProperties: false,
    },
    annotations: { title: "Prepare a protection policy", ...READ },
    run: async (args, deps) => {
      const net = args.network as Network;
      const user = String(args.account);
      const p = {
        hl_address: String(args.hl_address).toLowerCase(),
        keeper: DEPLOYED[net].keeper,
        warn: Number(args.warn ?? POLICY_DEFAULTS.warn),
        trigger: Number(args.trigger ?? POLICY_DEFAULTS.trigger),
        target: Number(args.target ?? POLICY_DEFAULTS.target),
        max_per_rescue: String(Math.round(Number(args.max_per_rescue_usdc ?? 25) * 1e6)),
        max_per_day: String(Math.round(Number(args.max_per_day_usdc ?? 50) * 1e6)),
        cooldown_sec: Number(args.cooldown_sec ?? POLICY_DEFAULTS.cooldownSec),
      };
      if (!(p.trigger < p.warn)) throw new ToolError("trigger must be below warn.");
      if (!(p.target > p.trigger)) throw new ToolError("target must be above trigger.");
      if (Number(p.max_per_day) < Number(p.max_per_rescue)) throw new ToolError("max_per_day_usdc must be at least max_per_rescue_usdc.");
      const current = await view<PolicyView | null>(deps, net, "get_policy", { user });
      const warnings: Warning[] = [];
      if (net === "mainnet") warnings.push(warning("KEEPER_NOT_ALWAYS_ON", "error", "The mainnet keeper doesn't run around the clock yet, so a mainnet policy would not protect anyone. Use testnet, or join the waitlist."));
      if (current !== null && current.hl_address.toLowerCase() !== p.hl_address) warnings.push(warning("ADDRESS_CHANGES", "warning", "This changes the Hyperliquid address the vault pays. Check it is the user's own."));
      if (current !== null && Number(p.max_per_day) > Number(current.max_per_day)) warnings.push(warning("CAP_RAISED", "warning", "This raises the daily cap: more can be sent in 24 hours than now."));
      if (p.trigger < 1.3) warnings.push(warning("LATE_TRIGGER", "warning", "A trigger this close to 1.0 leaves little time: a rescue takes the better part of a minute."));
      const risk = await readAccountRisk(p.hl_address, deps.info).catch(() => null);
      if (risk === null) warnings.push(warning("ACCOUNT_NOT_READ", "warning", "The Hyperliquid account couldn't be read, so this wasn't checked against its positions."));
      else if (risk.mode === "portfolio") warnings.push(warning("PORTFOLIO_MARGIN", "error", "This is a portfolio margin account, which Lifeline can't protect yet."));
      else if (risk.mode === "unified") warnings.push(warning("UNIFIED_ACCOUNT", "warning", "A top-up into a unified account hasn't been tested with real money, and the keeper reads its health lower than it is."));
      else if (risk.health < p.trigger) warnings.push(warning("BELOW_TRIGGER_NOW", "warning", "This account is already below the trigger: a rescue would start at once."));
      const summary = `Let ${p.keeper} top up ${p.hl_address}, and only that address, when health falls below ${p.trigger}, refilling to ${p.target}. At most ${usdc(p.max_per_rescue)} USDC per rescue and ${usdc(p.max_per_day)} USDC per 24 hours, ${p.cooldown_sec} s apart. Warn below ${p.warn}.`;
      const query = new URLSearchParams({ hl: p.hl_address, warn: String(p.warn), trigger: String(p.trigger), target: String(p.target), perRescue: String(usdc(p.max_per_rescue)), perDay: String(usdc(p.max_per_day)), cooldown: String(p.cooldown_sec) });
      return { ...unsigned(deps, net, user, "set_policy", { policy: p }, 30, current === null ? REGISTRATION : YOCTO, summary, warnings, `${SITE}/start?${query}`), replaces: current === null ? null : describePolicy(current) };
    },
  },
  {
    name: "prepare_pause",
    title: "Prepare a pause",
    description: "Returns an UNSIGNED transaction that stops all rescues for the user at once. It needs no deposit, so a key limited to the vault's pause method can send it. It changes nothing by itself.",
    inputSchema: { type: "object", properties: { account, network }, required: ["account", "network"], additionalProperties: false },
    annotations: { title: "Prepare a pause", ...READ },
    run: async (args, deps) => {
      const net = args.network as Network;
      return unsigned(deps, net, String(args.account), "pause", {}, 10, "0", "Stop every rescue for this account until it is unpaused.", [warning("UNPROTECTED", "warning", "While paused, nothing tops the account up.")], `${SITE}/position?user=${encodeURIComponent(String(args.account))}`);
    },
  },
  {
    name: "prepare_withdrawal",
    title: "Prepare a withdrawal",
    description: "Returns an UNSIGNED transaction that moves USDC from the user's reserve back to the user's own NEAR account. The vault can't send it anywhere else. It changes nothing by itself.",
    inputSchema: { type: "object", properties: { account, network, amount_usdc: { type: "number", minimum: 0.000001, maximum: 1_000_000_000, description: "How much, in USDC" } }, required: ["account", "network", "amount_usdc"], additionalProperties: false },
    annotations: { title: "Prepare a withdrawal", ...READ },
    run: async (args, deps) => {
      const net = args.network as Network;
      const user = String(args.account);
      const reserve = (await view<Record<string, string> | null>(deps, net, "get_reserve", { user }))?.[DEPLOYED[net].usdc];
      const held = typeof reserve === "string" && /^\d+$/.test(reserve) ? BigInt(reserve) : 0n;
      const amount = BigInt(Math.round(Number(args.amount_usdc) * 1e6));
      if (amount > held) throw new ToolError(`The reserve holds ${usdc(held.toString())} USDC, less than that.`);
      const warnings = amount === held ? [warning("EMPTIES_RESERVE", "warning", "This empties the reserve, so nothing can be topped up.")] : [];
      return unsigned(deps, net, user, "withdraw", { token: DEPLOYED[net].usdc, amount: amount.toString() }, 50, YOCTO, `Return ${usdc(amount.toString())} USDC from the reserve to ${user}.`, warnings, `${SITE}/fund`);
    },
  },
];
