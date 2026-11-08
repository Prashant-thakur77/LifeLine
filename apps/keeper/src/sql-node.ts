import Database from "better-sqlite3";
import type { SqlDatabase } from "./sql";
import { Store } from "./store";

/** A SQLite file in Node. Kept out of store.ts so the Cloudflare build never loads a native module. */
export function openSqlite(path: string): SqlDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  return {
    exec: (script) => {
      db.exec(script);
    },
    run: (query, ...params) => {
      db.prepare(query).run(...params);
    },
    all: <T>(query: string, ...params: (string | number | null)[]) => db.prepare(query).all(...params) as T[],
    get: <T>(query: string, ...params: (string | number | null)[]) => db.prepare(query).get(...params) as T | undefined,
    transaction: (work) => db.transaction(work)(),
    close: () => db.close(),
  };
}

export const openStore = (path: string): Store => new Store(openSqlite(path));
