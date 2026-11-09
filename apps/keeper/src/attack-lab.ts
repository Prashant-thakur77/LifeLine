import type { NearClient } from "./near";
import { VaultRejectedError } from "./ports";
import { signStandIn, signTestnetQuote } from "./stand-in-quote";

/**
 * The public attack lab: anyone can play a hacked keeper and send the testnet vault a
 * rescue that breaks one rule, signed with a keeper's real key. Each attack is a real
 * transaction, and the vault refuses it on chain. The lab keeper's only key can call
 * rescue on the vault and nothing else, the same as the real keeper's, so the worst a
 * visitor can do is spend its gas.
 */

export type AttackId = "pay-itself" | "pay-attacker" | "forged-quote" | "over-cap" | "stale-quote" | "refund-to-itself" | "reused-deposit";

export type Attack = {
  id: AttackId;
  title: string;
  /** What the hacked keeper does, in its own words. */
  move: string;
  /** The vault's own answer, word for word. */
  expect: string;
};

/** A Hyperliquid address the "attacker" wants paid. Nobody holds it; the vault never pays it. */
export const ATTACKER_HL = "0x6666666666666666666666666666666666666666";

export const ATTACKS: readonly Attack[] = [
  {
    id: "pay-itself",
    title: "Pay itself",
    move: "Takes a correctly signed quote for the user's own Hyperliquid address, and points the money at the keeper's own account instead of the quote's deposit address.",
    expect: "BAD_QUOTE: its deposit address isn't the one this rescue pays",
  },
  {
    id: "pay-attacker",
    title: "Pay the attacker's Hyperliquid",
    move: "Brings a quote that's genuinely signed, but pays the attacker's Hyperliquid address, and claims it's the user's.",
    expect: "BAD_QUOTE: it pays someone other than this user's Hyperliquid address",
  },
  {
    id: "forged-quote",
    title: "Edit a signed quote",
    move: "Takes a signed quote and quietly swaps its recipient for the attacker's address, keeping the original signature.",
    expect: "BAD_QUOTE: 1Click didn't sign this quote",
  },
  {
    id: "over-cap",
    title: "Take more than the cap",
    move: "Asks for 25.000001 USDC, one millionth over the user's 25 USDC limit per rescue, with a quote signed for exactly that.",
    expect: "OVER_PER_RESCUE: over this user's limit per rescue",
  },
  {
    id: "stale-quote",
    title: "Replay an old quote",
    move: "Sends a properly signed quote dated ten minutes ago, as if replaying one it saved back then.",
    expect: "BAD_QUOTE: it's more than 2 minutes old",
  },
  {
    id: "refund-to-itself",
    title: "Keep the refund",
    move: "Uses a signed quote whose refund goes to the keeper, so a swap that fails would pay the keeper.",
    expect: "BAD_QUOTE: a failed swap wouldn't refund this user",
  },
  {
    id: "reused-deposit",
    title: "Pay an old deposit address twice",
    move: "Sends money to a deposit address the vault has already paid once (on testnet, one from an earlier test rescue), hoping to collect a second payment.",
    expect: "DEPOSIT_REUSED: this deposit address was already paid",
  },
];

export const isAttackId = (value: unknown): value is AttackId => ATTACKS.some((attack) => attack.id === value);

/** Who the lab attacks: a test user whose policy names the lab keeper. */
export type LabTarget = {
  vault: string;
  keeper: string;
  user: string;
  token: string;
  hlAddress: string;
  maxPerRescue: string;
  /** A deposit address the vault has already paid (it remembers every one, for every user). */
  usedDeposit: string;
  /** The rescue that paid it, which the lab reads before attacking to be sure the vault remembers it. */
  usedDepositBy: { user: string; index: number };
};

/** The lab on NEAR testnet, set up on 2026-11-09. */
export const TESTNET_LAB: LabTarget = {
  vault: "vault.lifeline-team.testnet",
  keeper: "lab-keeper.lifeline-team.testnet",
  user: "bob.lifeline-team.testnet",
  token: "usdc.lifeline-team.testnet",
  hlAddress: "0x2222222222222222222222222222222222222222",
  maxPerRescue: "25000000",
  usedDeposit: "c79422d7b73e20ba6e30c9c323822a828267e36c4fbcaf82c4a34b7524c600b5",
  // alice.lifeline-team.testnet's rescue #25 (quote "latency-1794165270579"), never refunded.
  usedDepositBy: { user: "alice.lifeline-team.testnet", index: 25 },
};

export type RescueArgs = {
  user: string;
  token: string;
  amount: string;
  deposit_address: string;
  recipient: string;
  quote_id: string;
  quote: string;
  signature: string;
};

const AMOUNT = "3000000"; // 3 USDC: an ordinary rescue, well inside the caps

/** One rescue call that breaks exactly one rule and keeps every other one. */
export function buildAttack(id: AttackId, target: LabTarget, options: { signerKey: string; now: Date; freshDeposit: string }): RescueArgs {
  const { signerKey, now, freshDeposit } = options;
  const honest = { key: signerKey, user: target.user, token: target.token, amount: AMOUNT, recipient: target.hlAddress, depositAddress: freshDeposit, now };
  const call = (quote: { payload: string; signature: string }, overrides: Partial<RescueArgs> = {}): RescueArgs => ({
    user: target.user,
    token: target.token,
    amount: AMOUNT,
    deposit_address: freshDeposit,
    recipient: target.hlAddress,
    quote_id: `lab-${id}-${now.getTime()}`,
    quote: quote.payload,
    signature: quote.signature,
    ...overrides,
  });

  switch (id) {
    case "pay-itself":
      return call(signTestnetQuote(honest), { deposit_address: target.keeper });
    case "pay-attacker":
      return call(signTestnetQuote({ ...honest, recipient: ATTACKER_HL }));
    case "forged-quote": {
      const signed = signTestnetQuote(honest);
      const edited = signed.payload.replace(`"recipient":"${target.hlAddress}"`, `"recipient":"${ATTACKER_HL}"`);
      return call({ payload: edited, signature: signed.signature });
    }
    case "over-cap": {
      const amount = (BigInt(target.maxPerRescue) + 1n).toString();
      return call(signTestnetQuote({ ...honest, amount }), { amount });
    }
    case "stale-quote":
      return call(signTestnetQuote({ ...honest, timestamp: new Date(now.getTime() - 10 * 60_000) }));
    case "refund-to-itself":
      return call(signTestnetQuote({ ...honest, refundTo: target.keeper }));
    case "reused-deposit":
      return call(signTestnetQuote({ ...honest, depositAddress: target.usedDeposit }), { deposit_address: target.usedDeposit });
  }
}

export type AttackResult = {
  id: AttackId;
  at: string;
  txHash: string;
  /** False only if the vault accepted it, which closes the lab. */
  refused: boolean;
  /** Refused with exactly the answer this attack aims for. Anything else is logged for a look. */
  matched: boolean;
  /** The vault's panic, word for word, or what happened instead. */
  answer: string;
  expected: string;
};

/** What the lab keeps across restarts: the latest results and the day's count. */
export type LabSaved = { recent: AttackResult[]; day: number; count: number };

/** Too soon after the last attack, or over an allowance. */
export class LabBusy extends Error {
  constructor(
    message: string,
    readonly retryAfterSec: number,
  ) {
    super(message);
  }
}

/** The lab is closed: an attack got through, the chain isn't as the attacks assume, or the keeper is out of gas. */
export class LabClosed extends Error {}

export function panicOf(failure: string | null): string | null {
  if (failure === null) return null;
  const match = /"ExecutionError":"((?:[^"\\]|\\.)*)"/.exec(failure);
  if (!match) return null;
  try {
    return (JSON.parse(`"${match[1]}"`) as string).replace(/^Smart contract panicked: /, "");
  } catch {
    return match[1]!.replace(/^Smart contract panicked: /, "");
  }
}

const RECENT = 20;
const DAY_MS = 86_400_000;
const PREFLIGHT_MS = 10 * 60_000;

type Raw = Record<string, unknown>;

/**
 * Two attacks are refused only because of chain state: "over the cap" needs the target's
 * cap to be what the attack exceeds, and "pay an old deposit address twice" needs the
 * vault to remember that address. Everything the attacks rely on is read back first; if
 * any of it has changed, the lab closes rather than risk an attack the vault would accept.
 */
export async function checkLabTarget(client: NearClient, target: LabTarget): Promise<string | null> {
  const policy = (await client.view("get_policy", { user: target.user })) as Raw | null;
  if (policy === null) return `${target.user} has no policy`;
  if (policy.keeper !== target.keeper) return `${target.user}'s policy no longer names the lab keeper`;
  if (String(policy.hl_address).toLowerCase() !== target.hlAddress) return `${target.user}'s Hyperliquid address changed`;
  if (String(policy.max_per_rescue) !== target.maxPerRescue) return `${target.user}'s limit per rescue changed`;
  if (policy.paused === true) return `${target.user} has paused rescues`;
  const [paid] = ((await client.view("get_rescues", { user: target.usedDepositBy.user, from: target.usedDepositBy.index, limit: 1 })) as Raw[] | null) ?? [];
  if (paid?.deposit_address !== target.usedDeposit || paid.refunded !== false) return "the vault's record of the already-paid deposit address changed";
  return null;
}

export type AttackLab = ReturnType<typeof createAttackLab>;

export function createAttackLab(options: {
  client: NearClient;
  target: LabTarget;
  signerKey: string;
  now: () => Date;
  log: (line: string) => void;
  /** 64 hex characters: a fresh implicit account, as 1Click's deposit addresses are. */
  freshDeposit?: () => string;
  /** At least this long between attacks, so the lab can't be used to flood testnet. */
  minGapMs?: number;
  /** At most this many attacks per UTC day, for everyone together. */
  perDay?: number;
  /** At most this many per UTC day from one visitor, so one script can't use up the day. */
  perVisitor?: number;
  saved?: LabSaved | null;
  onSave?: (saved: LabSaved) => void;
}) {
  const { client, target, signerKey, now, log, minGapMs = 8_000, perDay = 300, perVisitor = 40 } = options;
  const freshDeposit =
    options.freshDeposit ?? (() => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""));
  const dayOf = (ms: number) => Math.floor(ms / DAY_MS);
  let recent: AttackResult[] = [...(options.saved?.recent ?? [])].slice(0, RECENT);
  let day = options.saved?.day ?? dayOf(now().getTime());
  let count = options.saved?.count ?? 0;
  let running = false;
  let closedBecause: string | null = recent.some((r) => !r.refused) ? "an attack got through, and the team is looking at the vault" : null;
  let lastAt = recent[0] ? Date.parse(recent[0].at) : 0;
  let checkedAt = -Infinity;
  const visitors = new Map<string, number>();

  const close = (reason: string) => {
    closedBecause = reason;
    log(`the attack lab closed: ${reason}`);
  };

  return {
    info() {
      return { open: closedBecause === null, ...(closedBecause === null ? {} : { closedBecause }), target, attacks: ATTACKS, recent };
    },

    /** `visitor` is who asked (their IP on Cloudflare), for the per-visitor allowance. */
    async run(id: AttackId, visitor = "anyone"): Promise<AttackResult> {
      if (closedBecause !== null) throw new LabClosed(`the lab is closed: ${closedBecause}`);
      const at = now();
      const thisDay = dayOf(at.getTime());
      if (thisDay !== day) {
        day = thisDay;
        count = 0;
        visitors.clear();
      }
      if (running) throw new LabBusy("another attack is on its way to the vault; try again in a few seconds", 5);
      const wait = lastAt + minGapMs - at.getTime();
      if (wait > 0) throw new LabBusy("one attack at a time: the last one went out a moment ago", Math.ceil(wait / 1000));
      const untilMidnight = Math.ceil(((thisDay + 1) * DAY_MS - at.getTime()) / 1000);
      if (count >= perDay) throw new LabBusy("the lab has sent today's attacks; it opens again at midnight UTC", untilMidnight);
      if ((visitors.get(visitor) ?? 0) >= perVisitor) throw new LabBusy("you've sent today's share of attacks; more at midnight UTC", untilMidnight);

      running = true;
      try {
        if (at.getTime() - checkedAt > PREFLIGHT_MS) {
          const problem = await checkLabTarget(client, target);
          if (problem !== null) {
            close(problem);
            throw new LabClosed(`the lab is closed: ${problem}`);
          }
          checkedAt = at.getTime();
        }
        lastAt = at.getTime();
        count += 1;
        visitors.set(visitor, (visitors.get(visitor) ?? 0) + 1);
        const attack = ATTACKS.find((a) => a.id === id)!;
        const args = buildAttack(id, target, { signerKey, now: at, freshDeposit: freshDeposit() });
        let sent: { txHash: string; failure: string | null };
        try {
          sent = await client.call("rescue", args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`lab attack ${id} got no answer: ${message}`);
          // NEAR refused the transaction itself: most likely the lab keeper is out of testnet NEAR.
          if (error instanceof VaultRejectedError) {
            close(/balance/i.test(message) ? "the lab keeper has run out of testnet NEAR for gas" : "NEAR refused the lab keeper's transactions");
            throw new LabClosed(`the lab is closed: ${closedBecause}`);
          }
          throw error;
        }
        const panic = panicOf(sent.failure);
        const result: AttackResult = {
          id,
          at: at.toISOString(),
          txHash: sent.txHash,
          refused: sent.failure !== null,
          matched: panic === attack.expect,
          answer: panic ?? (sent.failure === null ? "accepted" : "failed without a panic"),
          expected: attack.expect,
        };
        if (!result.refused) close(`an attack got through (${id}, ${sent.txHash}), and the team is looking at the vault`);
        else if (!result.matched) log(`lab attack ${id} was refused for another reason than expected, in ${sent.txHash}: ${result.answer}`);
        recent = [result, ...recent].slice(0, RECENT);
        options.onSave?.({ recent, day, count });
        return result;
      } finally {
        running = false;
      }
    },
  };
}
