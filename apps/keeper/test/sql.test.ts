import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../src/sql";
import { durableSql } from "../src/sql-durable";
import { openSqlite } from "../src/sql-node";
import { fakeDurableStorage } from "./fake-durable-storage";

const DRIVERS: [string, () => SqlDatabase][] = [
  ["better-sqlite3", () => openSqlite(":memory:")],
  ["a Durable Object's SQLite", () => durableSql(fakeDurableStorage())],
];

describe.each(DRIVERS)("the SQL driver on %s", (_driver, open) => {
  const withRows = () => {
    const db = open();
    db.exec("CREATE TABLE t (n INTEGER); CREATE TABLE u (n INTEGER);");
    for (const n of [1, 2, 3]) db.run("INSERT INTO t (n) VALUES (?)", n);
    return db;
  };

  it("runs a script of several statements", () => {
    const db = withRows();
    expect(db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).toEqual([{ name: "t" }, { name: "u" }]);
  });

  it("gets the first row, or nothing", () => {
    const db = withRows();
    expect(db.get("SELECT n FROM t ORDER BY n")).toEqual({ n: 1 });
    expect(db.get("SELECT n FROM t WHERE n > ?", 9)).toBeUndefined();
  });

  it("lists every row, with bindings", () => {
    const db = withRows();
    expect(db.all("SELECT n FROM t WHERE n >= ? ORDER BY n", 2)).toEqual([{ n: 2 }, { n: 3 }]);
  });

  it("returns rows from a write with RETURNING", () => {
    const db = withRows();
    expect(db.all("DELETE FROM t WHERE n < ? RETURNING n", 3)).toHaveLength(2);
    expect(db.all("SELECT n FROM t")).toEqual([{ n: 3 }]);
  });

  it("rolls a whole transaction back when it throws", () => {
    const db = withRows();
    expect(() =>
      db.transaction(() => {
        db.run("DELETE FROM t");
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(db.all("SELECT n FROM t")).toHaveLength(3);
  });

  it("returns what a transaction returns", () => {
    const db = withRows();
    expect(db.transaction(() => db.all("SELECT n FROM t").length)).toBe(3);
  });
});
