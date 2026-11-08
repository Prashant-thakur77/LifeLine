const REFRESH_MS = 60_000;

/**
 * Who the keeper watches: the users configured by hand, plus everyone registered in the
 * vault, read again at most once a minute. users() never waits for the vault, so a slow
 * RPC node can't hold up a tick; it answers from the last list it read.
 */
export function createUserList(options: {
  fixed: string[];
  load: () => Promise<string[]>;
  now: () => number;
  log: (line: string) => void;
  refreshMs?: number;
}): { users(): string[] } {
  const { fixed, load, now, log, refreshMs = REFRESH_MS } = options;
  let loaded: string[] = [];
  let nextLoadAt = 0;
  let loading = false;

  return {
    users() {
      if (!loading && now() >= nextLoadAt) {
        loading = true;
        nextLoadAt = now() + refreshMs;
        load()
          .then((list) => {
            loaded = list;
          })
          .catch((error: unknown) => log(`couldn't list the vault's users: ${error instanceof Error ? error.message : String(error)}`))
          .finally(() => {
            loading = false;
          });
      }
      return [...new Set([...fixed, ...loaded])];
    },
  };
}
