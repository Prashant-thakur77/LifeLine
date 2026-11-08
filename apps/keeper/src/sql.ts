export type SqlValue = string | number | null;

/**
 * The few calls the store makes. better-sqlite3 provides them in Node (sql-node.ts),
 * and a Durable Object's own SQLite on Cloudflare (sql-durable.ts), so the same
 * store and the same tests serve both.
 */
export interface SqlDatabase {
  /** Runs a script of statements with no bindings, such as the schema. */
  exec(script: string): void;
  run(query: string, ...params: SqlValue[]): void;
  all<T>(query: string, ...params: SqlValue[]): T[];
  get<T>(query: string, ...params: SqlValue[]): T | undefined;
  /** All of `work` happens, or none of it does. `work` must be synchronous. */
  transaction<T>(work: () => T): T;
  close(): void;
}
