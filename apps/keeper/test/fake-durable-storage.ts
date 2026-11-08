import Database from "better-sqlite3";
import type { DurableSqlStorage } from "../src/sql-durable";

/**
 * Stands in for a Durable Object's storage in Node tests: the same two calls, on an
 * in-memory SQLite. As on Cloudflare, a query may hold several statements when it
 * has no bindings. wrangler dev runs the adapter on the real thing.
 */
export function fakeDurableStorage(): DurableSqlStorage {
  const db = new Database(":memory:");
  return {
    sql: {
      exec(query, ...bindings) {
        let statement: Database.Statement;
        try {
          statement = db.prepare(query);
        } catch (error) {
          if (bindings.length > 0 || !/more than one statement/.test(String(error))) throw error;
          db.exec(query);
          return { toArray: () => [] };
        }
        const rows = statement.reader ? statement.all(...bindings) : (statement.run(...bindings), []);
        return { toArray: () => rows };
      },
    },
    transactionSync: (work) => db.transaction(work)(),
  };
}
