import type { AuditRecord } from "@lifeline/shared";
import type { Store } from "./store";

/**
 * What happens to a record after it's safely in the audit log: explain it, save the
 * words beside it, then tell the user. Runs apart from the rescue, and never throws.
 * Each user's records stay in order, and one user's slow model call can't hold up another's.
 */
export function createRecordPipeline(options: {
  store: Store;
  explain: (record: AuditRecord) => Promise<string | undefined>;
  notify: (record: AuditRecord) => Promise<void>;
  log: (line: string) => void;
}) {
  const { store, explain, notify, log } = options;
  const queues = new Map<string, Promise<void>>();

  const process = async (record: AuditRecord): Promise<void> => {
    let explanation: string | undefined;
    try {
      explanation = await explain(record);
      if (explanation !== undefined) store.setExplanation(record.id, explanation);
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
      const next = (queues.get(record.user) ?? Promise.resolve()).then(() => process(record));
      queues.set(record.user, next);
    },
    /** Resolves once everything handled so far is finished. */
    async settled(): Promise<void> {
      await Promise.all(queues.values());
    },
  };
}
