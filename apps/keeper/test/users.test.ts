import { describe, expect, it } from "vitest";
import { canRescue, createUserList } from "../src/users";

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

describe("choosing whom to watch from the vault", () => {
  const setup = (vaultUsers: string[], accept: (user: string) => Promise<boolean>, max?: number) => {
    let nowMs = 0;
    const asked: string[] = [];
    const list = createUserList({
      fixed: ["alice.near"],
      load: async () => vaultUsers,
      accept: async (user) => {
        asked.push(user);
        return accept(user);
      },
      now: () => nowMs,
      log: () => {},
      ...(max === undefined ? {} : { max }),
    });
    return { list, asked, advance: (ms: number) => (nowMs += ms) };
  };

  it("watches only users the check accepts: ours, with a reserve that can pay a rescue", async () => {
    const { list } = setup(["bob.near", "sybil.near"], async (user) => user === "bob.near");
    list.users();
    await settle();
    await settle();
    expect(list.users()).toEqual(["alice.near", "bob.near"]);
  });

  it("remembers each answer for 10 minutes instead of asking about everyone every minute", async () => {
    const { list, asked, advance } = setup(["bob.near", "sybil.near"], async (user) => user === "bob.near");
    list.users();
    await settle();
    await settle();
    advance(60_000);
    list.users();
    await settle();
    await settle();
    expect(asked.filter((u) => u === "sybil.near")).toHaveLength(1);
    advance(10 * 60_000);
    list.users();
    await settle();
    await settle();
    expect(asked.filter((u) => u === "sybil.near")).toHaveLength(2);
  });

  it("watches at most `max`, the configured users first, so fake sign-ups can't exhaust the keeper", async () => {
    const many = Array.from({ length: 80 }, (_, i) => `user${i}.near`);
    const { list } = setup(many, async () => true, 50);
    list.users();
    await settle();
    await settle();
    const watched = list.users();
    expect(watched).toHaveLength(50);
    expect(watched[0]).toBe("alice.near");
  });

  it("leaves out a user whose check fails, until it can be checked", async () => {
    const { list } = setup(["bob.near"], async () => {
      throw new Error("rpc down");
    });
    list.users();
    await settle();
    await settle();
    expect(list.users()).toEqual(["alice.near"]);
  });
});

describe("canRescue", () => {
  const vault = (policy: boolean, reserve: string) => ({
    getPolicy: async () => (policy ? ({} as never) : null),
    getReserve: async () => reserve,
  });

  it("accepts a user whose policy names this keeper and whose reserve covers the smallest rescue", async () => {
    expect(await canRescue(vault(true, "2000000"))("bob.near")).toBe(true);
  });

  it("refuses one with no policy for this keeper, or less than 2 USDC", async () => {
    expect(await canRescue(vault(false, "100000000"))("bob.near")).toBe(false);
    expect(await canRescue(vault(true, "1999999"))("bob.near")).toBe(false);
  });
});
