import type { SqlDatabase, SqlValue } from "./sql";

/** The two parts of a Durable Object's storage the store uses, typed here so Node code needn't load Cloudflare's types. */
export type DurableSqlStorage = {
  sql: { exec(query: string, ...bindings: SqlValue[]): { toArray(): unknown[] } };
  transactionSync<T>(work: () => T): T;
};

/**
 * A Durable Object's own SQLite. Its rows live with the object, survive restarts and
 * deploys, and only that object can reach them. Every cursor is read straight away:
 * Cloudflare doesn't promise one held across an await still sees the same data.
 */
export function durableSql(storage: DurableSqlStorage): SqlDatabase {
  const rows = (query: string, params: SqlValue[]) => storage.sql.exec(query, ...params).toArray();
  return {
    exec: (script) => {
      storage.sql.exec(script).toArray();
    },
    run: (query, ...params) => {
      rows(query, params);
    },
    all: <T>(query: string, ...params: SqlValue[]) => rows(query, params) as T[],
    get: <T>(query: string, ...params: SqlValue[]) => rows(query, params)[0] as T | undefined,
    transaction: (work) => storage.transactionSync(work),
    close: () => {},
  };
}
