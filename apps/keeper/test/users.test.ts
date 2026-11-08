import { describe, expect, it } from "vitest";
import { createUserList } from "../src/users";

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("the list of users to watch", () => {
  const setup = (load: () => Promise<string[]>) => {
    let nowMs = 0;
    const logs: string[] = [];
    let loads = 0;
    const list = createUserList({
      fixed: ["alice.near"],
      load: () => {
        loads += 1;
        return load();
      },
      now: () => nowMs,
      log: (line) => logs.push(line),
    });
    return { list, logs, loads: () => loads, advance: (ms: number) => (nowMs += ms) };
  };

  it("starts with the configured users, then adds everyone the vault lists, once each", async () => {
    const { list } = setup(async () => ["bob.near", "alice.near"]);
    expect(list.users()).toEqual(["alice.near"]);
    await settle();
    expect(list.users()).toEqual(["alice.near", "bob.near"]);
  });

  it("asks the vault at most once a minute", async () => {
    const { list, loads, advance } = setup(async () => ["bob.near"]);
    list.users();
    await settle();
    list.users();
    advance(59_000);
    list.users();
    expect(loads()).toBe(1);
    advance(1_000);
    list.users();
    expect(loads()).toBe(2);
  });

  it("never asks twice at once while the vault is slow", async () => {
    const { list, loads, advance } = setup(() => new Promise(() => {}));
    list.users();
    advance(120_000);
    list.users();
    expect(loads()).toBe(1);
  });

  it("keeps the last list it read when the vault can't be read, and says so", async () => {
    let fail = false;
    const { list, logs, advance } = setup(async () => {
      if (fail) throw new Error("RPC down");
      return ["bob.near"];
    });
    list.users();
    await settle();
    fail = true;
    advance(60_000);
    list.users();
    await settle();
    expect(list.users()).toEqual(["alice.near", "bob.near"]);
    expect(logs.join("\n")).toMatch(/couldn't list the vault's users: RPC down/);
  });
});
