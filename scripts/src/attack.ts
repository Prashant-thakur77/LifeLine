import { requestFromQuote, type Intents, type NearClient, type Quote } from "@lifeline/keeper";
import { evaluate, type PolicyRequest, type RescueHistory } from "@lifeline/policy";
import { ASSETS, POLICY_DEFAULTS, type HealthSnapshot, type Policy, type PolicyDecision } from "@lifeline/shared";

export const ATTACKER_HL = "0x9999999999999999999999999999999999999999";
const VICTIM = "demo.near"; // 1Click refuses a refund account that doesn't exist
const VICTIM_HL = "0x1111111111111111111111111111111111111111";
const ATTACKER_NEAR = "wrap.near"; // any real account stands in for the attacker's
const HYPEREVM_USDC = "1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const FIVE_USDC = "5000000";
const THOUSAND_USDC = "1000000000";
const ELEVEN_MINUTES_MS = 11 * 60_000;
const THIRTY_SECONDS_MS = 30_000;

export type AttackAttempt = {
  name: string;
  expected: "allow" | "block";
  outcome: "allow" | "block";
  by: "policy engine" | "quote signature";
  reasons: string[];
};

export type EngineAttackDeps = {
  quotes: Pick<Intents, "getQuote">;
  /** Fetches a real quote and changes it after 1Click signed it. It should throw. */
  tamperedQuote: () => Promise<Quote>;
  now: () => Date;
  /** Only tests replace this, to prove a broken engine would show up. */
  evaluateFn?: typeof evaluate;
};

/** Fires each attack a hacked or prompt-injected keeper could try at the real policy engine. */
export async function runEngineAttacks(deps: EngineAttackDeps): Promise<AttackAttempt[]> {
  const { quotes, tamperedQuote, now } = deps;
  const judge = deps.evaluateFn ?? evaluate;
  const at = now();

  const policy: Policy = { user: VICTIM, hlAddress: VICTIM_HL, ...POLICY_DEFAULTS, paused: false };
  const history: RescueHistory = { rescues: [], reserve: "100000000" };
  const snapshot: HealthSnapshot = {
    hlAddress: VICTIM_HL,
    accountValue: 10,
    maintenanceMarginUsed: 7,
    health: 10 / 7,
    positions: [{ coin: "ETH", size: 0.1, entryPx: 3000, liquidationPx: 2750 }],
    at: at.toISOString(),
  };

  const quote = (over: { amount?: string; recipient?: string; refundTo?: string } = {}) =>
    quotes.getQuote({ amount: FIVE_USDC, recipient: VICTIM_HL, refundTo: VICTIM, dry: true, ...over });
  const request = (from: Quote, over: Partial<PolicyRequest> = {}): PolicyRequest => ({
    ...requestFromQuote({
      id: "attack",
      user: VICTIM,
      token: ASSETS.NEAR_USDC.contractId,
      quote: from,
      depositAddress: "attacker-controlled",
      usdNeeded: Number(from.amountIn) / 10 ** ASSETS.NEAR_USDC.decimals / 1.01 - Number(from.withdrawFee) / 10 ** ASSETS.HYPERLIQUID_USDC.decimals,
      snapshot,
    }),
    // A fixed time, because this checks the rule rather than the network's speed.
    quoteAt: at.toISOString(),
    ...over,
  });
  const engine = (
    name: string,
    expected: AttackAttempt["expected"],
    decision: PolicyDecision,
  ): AttackAttempt => ({ name, expected, outcome: decision.verdict, by: "policy engine", reasons: decision.reasons });

  const honest = await quote();
  const attempts: AttackAttempt[] = [
    engine("Honest rescue, as a control", "allow", judge(request(honest), policy, history, snapshot, at)),
    engine(
      "Pay a genuinely signed quote to the attacker's address",
      "block",
      judge(request(await quote({ recipient: ATTACKER_HL })), policy, history, snapshot, at),
    ),
    engine(
      "Send a failed swap's refund to the attacker",
      "block",
      judge(request(await quote({ refundTo: ATTACKER_NEAR })), policy, history, snapshot, at),
    ),
    engine(
      "Deliver to HyperEVM, where USDC adds no margin",
      "block",
      judge(request(honest, { destinationAsset: HYPEREVM_USDC }), policy, history, snapshot, at),
    ),
    engine(
      "Drain 1,000 USDC in one rescue",
      "block",
      judge(request(await quote({ amount: THOUSAND_USDC })), policy, history, snapshot, at),
    ),
    engine("Rescue while the user has paused", "block", judge(request(honest), { ...policy, paused: true }, history, snapshot, at)),
    engine(
      "Rescue again during the cooldown",
      "block",
      judge(
        request(honest),
        policy,
        { ...history, rescues: [{ amount: FIVE_USDC, at: new Date(at.getTime() - THIRTY_SECONDS_MS).toISOString() }] },
        snapshot,
        at,
      ),
    ),
    engine(
      "Rescue a healthy account, to burn its reserve",
      "block",
      judge(request(honest), policy, history, { ...snapshot, accountValue: 21, health: 3 }, at),
    ),
    engine(
      "Reuse a stale quote",
      "block",
      judge(request(honest, { quoteAt: new Date(at.getTime() - ELEVEN_MINUTES_MS).toISOString() }), policy, history, snapshot, at),
    ),
  ];

  let tamperedVerdict: Pick<AttackAttempt, "outcome" | "reasons">;
  try {
    await tamperedQuote();
    tamperedVerdict = { outcome: "allow", reasons: [] };
  } catch (error) {
    tamperedVerdict = { outcome: "block", reasons: [error instanceof Error ? error.message : String(error)] };
  }
  attempts.push({ name: "Change a quote's recipient after 1Click signed it", expected: "block", by: "quote signature", ...tamperedVerdict });
  return attempts;
}

export function formatAttempt(attempt: AttackAttempt): string {
  const { name, expected, outcome, by, reasons } = attempt;
  if (expected === "allow") return `${outcome === "allow" ? "ALLOWED    " : "NOT ALLOWED"}  ${name}`;
  if (outcome === "allow") return `NOT REFUSED  ${name}`;
  return `REFUSED      ${name}\n             by the ${by}: ${reasons.join(", ")}`;
}

export type AttackProof = {
  network: "mainnet";
  txHash: string;
  signer: string;
  vault: string;
  failure: string;
  recordedAt: string;
};

/**
 * The second layer: the keeper's own key calls rescue directly with the attacker as
 * recipient, skipping the engine. It sends a real mainnet transaction, so only a human
 * runs it. Should the contract ever accept it, 1 base unit goes to the team's own account.
 */
export async function sendContractAttack(
  client: NearClient,
  config: { vaultId: string; keeperAccountId: string; user: string; token: string },
  now: () => Date,
): Promise<AttackProof> {
  const { txHash, failure } = await client.call("rescue", {
    user: config.user,
    token: config.token,
    amount: "1",
    deposit_address: config.keeperAccountId,
    recipient: ATTACKER_HL,
    quote_id: "attack-demo",
  });
  if (failure === null) throw new Error(`THE CONTRACT ACCEPTED THE ATTACK in ${txHash}. Stop and look at the vault.`);
  return {
    network: "mainnet",
    txHash,
    signer: config.keeperAccountId,
    vault: config.vaultId,
    failure,
    recordedAt: now().toISOString(),
  };
}

export function parseProof(text: string): AttackProof | null {
  try {
    const proof = JSON.parse(text) as Partial<AttackProof> | null;
    const fields = [proof?.txHash, proof?.signer, proof?.vault, proof?.failure, proof?.recordedAt];
    return proof?.network === "mainnet" && fields.every((field) => typeof field === "string") ? (proof as AttackProof) : null;
  } catch {
    return null;
  }
}

/** Asks a public node what really happened, so nobody has to take the saved proof's word for it. */
export async function checkProof(
  proof: AttackProof,
  rpcUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ refused: boolean; detail: string }> {
  const response = await fetchFn(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "lifeline",
      method: "tx",
      params: { tx_hash: proof.txHash, sender_account_id: proof.signer, wait_until: "FINAL" },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as {
    result?: { status?: { Failure?: unknown }; transaction?: { receiver_id?: string; signer_id?: string } };
  };
  const { result } = body;
  if (result === undefined) return { refused: false, detail: "couldn't find this transaction on the node" };

  const failure = result.status?.Failure;
  const right = result.transaction?.receiver_id === proof.vault && result.transaction?.signer_id === proof.signer;
  if (!right) return { refused: false, detail: "this transaction isn't from the keeper to the vault" };
  if (failure === undefined) return { refused: false, detail: "this transaction succeeded" };
  return { refused: true, detail: JSON.stringify(failure) };
}
