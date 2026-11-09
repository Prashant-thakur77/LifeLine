import type { AuditRecord } from "@lifeline/shared";
import type { Explained } from "./explain";
import type { Store } from "./store";

const BACKFILL_LIMIT = 200;

/**
 * What happens to a record after it's safely in the audit log: explain it, save the
 * words beside it, then tell the user. Runs apart from the rescue, and never throws.
 * Each user's records stay in order, and one user's slow model call can't hold up another's.
 */
export function createRecordPipeline(options: {
  store: Store;
  explain: (record: AuditRecord) => Promise<Explained | undefined>;
  notify: (record: AuditRecord) => Promise<void>;
  log: (line: string) => void;
}) {
  const { store, explain, notify, log } = options;
  const queues = new Map<string, Promise<void>>();
  const enqueue = (user: string, work: () => Promise<void>) => {
    queues.set(user, (queues.get(user) ?? Promise.resolve()).then(work));
  };

  const process = async (record: AuditRecord): Promise<void> => {
    let explanation: string | undefined;
    try {
      const explained = await explain(record);
      if (explained !== undefined) {
        explanation = explained.text;
        store.setExplanation(record.id, explained.text, explained.proof);
      }
    } catch {
      log(`couldn't explain record ${record.id}`);
    }
    try {
      await notify(explanation === undefined ? record : { ...record, explanation });
    } catch {
      log(`couldn't send record ${record.id}`);
    }
  };

  return {
    handle(record: AuditRecord): void {
      enqueue(record.user, () => process(record));
    },
    /** At startup: explains what a crash left unexplained. People were already told, so nobody is messaged. */
    backfill(): void {
      for (const record of store.unexplained(BACKFILL_LIMIT)) {
        enqueue(record.user, async () => {
          try {
            const explained = await explain(record);
            if (explained !== undefined) store.setExplanation(record.id, explained.text, explained.proof);
          } catch {
            log(`couldn't explain record ${record.id}`);
          }
        });
      }
    },
    /** Resolves once everything handled so far is finished. */
    async settled(): Promise<void> {
      await Promise.all(queues.values());
    },
  };
}
