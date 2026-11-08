import { ASSETS } from "@lifeline/shared";
import type { Vault } from "./ports";
import { MIN_RESCUE_UNITS } from "./sizing";

const REFRESH_MS = 60_000;
const VERDICT_MS = 10 * 60_000;
const DEFAULT_MAX = 50;

/**
 * Who the keeper watches: the users configured by hand, plus everyone registered in the
 * vault that `accept` approves (their policy names this keeper, and their reserve can pay
 * a rescue). The vault list is read again at most once a minute and each user's verdict is
 * kept for 10 minutes, so watching costs little however many accounts sign up. At most
 * `max` users are watched, the configured ones first: anyone can register for 0.05 NEAR,
 * and fake sign-ups mustn't use up the keeper's daily storage writes. users() never waits
 * for the vault; it answers from the last list it read.
 */
export function createUserList(options: {
  fixed: string[];
  load: () => Promise<string[]>;
  accept?: (user: string) => Promise<boolean>;
  now: () => number;
  log: (line: string) => void;
  refreshMs?: number;
  max?: number;
}): { users(): string[] } {
  const { fixed, load, accept, now, log, refreshMs = REFRESH_MS, max = DEFAULT_MAX } = options;
  let loaded: string[] = [];
  let nextLoadAt = 0;
  let loading = false;
  const verdicts = new Map<string, { ok: boolean; until: number }>();

  const judge = async (users: string[]): Promise<string[]> => {
    if (accept === undefined) return users;
    const kept: string[] = [];
    for (const user of users) {
      if (fixed.includes(user)) continue;
      const known = verdicts.get(user);
      if (known === undefined || known.until <= now()) {
        try {
          verdicts.set(user, { ok: await accept(user), until: now() + VERDICT_MS });
        } catch {
          verdicts.delete(user); // asked again next time
          continue;
        }
      }
      if (verdicts.get(user)?.ok) kept.push(user);
    }
    return kept;
  };

  return {
    users() {
      if (!loading && now() >= nextLoadAt) {
        loading = true;
        nextLoadAt = now() + refreshMs;
        load()
          .then(judge)
          .then((list) => {
            loaded = list;
          })
          .catch((error: unknown) => log(`couldn't list the vault's users: ${error instanceof Error ? error.message : String(error)}`))
          .finally(() => {
            loading = false;
          });
      }
      return [...new Set([...fixed, ...loaded])].slice(0, Math.max(max, fixed.length));
    },
  };
}

/** A vault user is worth watching if their policy names this keeper and their reserve can pay a rescue. */
export function canRescue(vault: Pick<Vault, "getPolicy" | "getReserve">): (user: string) => Promise<boolean> {
  return async (user) => {
    if ((await vault.getPolicy(user)) === null) return false;
    return BigInt(await vault.getReserve(user, ASSETS.NEAR_USDC.contractId)) >= MIN_RESCUE_UNITS;
  };
}
