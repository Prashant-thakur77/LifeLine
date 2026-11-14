import type { Quote, SwapStatus } from "@lifeline/intents";
import { describe, expect, it } from "vitest";
import {
  AMOUNT,
  DRY_REFUND_ACCOUNT,
  TIDEPOOL,
  depositActions,
  formatSummary,
  quoteProblems,
  readSettings,
  waitForBalanceChange,
  waitForFinalStatus,
} from "../src/tidepool";

const HL = "0xeb53d86545691F875b0F35745899A7A1E27706a9";
const DEPOSIT = "03cfd0be9c1e30dea1df9b68f4fb6aa7aa023efc4c8ac57d57204937898cdc6e";
const ENV = { HL_TESTNET_ADDRESS: HL, NEAR_TESTNET_ACCOUNT: "me.testnet", NEAR_TESTNET_PRIVATE_KEY: "ed25519:fake" };

describe("readSettings", () => {
  it("runs for real with the account, its key and the Hyperliquid address from .env", () => {
    expect(readSettings([], ENV)).toEqual({ dry: false, hlAddress: HL, nearAccount: "me.testnet", nearKey: "ed25519:fake" });
  });

  it("needs only an address for --dry, and never holds a key then", () => {
    expect(readSettings(["--dry", HL], {})).toEqual({ dry: true, hlAddress: HL, nearAccount: DRY_REFUND_ACCOUNT, nearKey: null });
    expect(readSettings(["--dry"], ENV).nearKey).toBeNull();
  });

  it("lets a passed address win over .env's", () => {
    const other = "0x1111111111111111111111111111111111111111";
    expect(readSettings(["--dry", other], ENV).hlAddress).toBe(other);
  });

  it("refuses the real run without the account or key, and says --dry needs neither", () => {
    expect(() => readSettings([], { HL_TESTNET_ADDRESS: HL })).toThrow(/--dry needs neither/);
    expect(() => readSettings([], { ...ENV, NEAR_TESTNET_PRIVATE_KEY: " " })).toThrow(/NEAR_TESTNET_PRIVATE_KEY/);
  });

  it("refuses a mainnet account, a bad key, a bad address and an unknown argument", () => {
    expect(() => readSettings([], { ...ENV, NEAR_TESTNET_ACCOUNT: "me.near" })).toThrow(/only runs on testnet/);
    expect(() => readSettings([], { ...ENV, NEAR_TESTNET_PRIVATE_KEY: "secp256k1:x" })).toThrow(/ed25519/);
    expect(() => readSettings(["--dry"], {})).toThrow(/HL_TESTNET_ADDRESS/);
    expect(() => readSettings(["--dry", "--send"], ENV)).toThrow(/unknown argument: --send/);
  });
});

describe("quoteProblems", () => {
  const quote: Quote = {
    quoteId: "q",
    depositAddress: DEPOSIT,
    amountIn: AMOUNT,
    minAmountOut: "2962278",
    withdrawFee: "0",
    recipient: HL,
    refundTo: "me.testnet",
    destinationAsset: TIDEPOOL.destinationAsset,
    quotedAt: "2026-11-13T07:00:00.000Z",
  };
  const expected = { recipient: HL, refundTo: "me.testnet", amount: AMOUNT };

  it("finds nothing wrong with an honest quote, and compares 0x addresses in any case", () => {
    expect(quoteProblems(quote, expected)).toEqual([]);
    expect(quoteProblems({ ...quote, recipient: HL.toLowerCase() }, expected)).toEqual([]);
  });

  it("names every field that doesn't match, all at once", () => {
    const bad: Quote = { ...quote, recipient: "0x9999999999999999999999999999999999999999", destinationAsset: "nep141:usdc.tidepool-sandbox.testnet", refundTo: "attacker.testnet", amountIn: "4000000" };
    const problems = quoteProblems(bad, expected);
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toMatch(/pays 0x9999/);
    expect(problems.join("\n")).toMatch(/delivers nep141:usdc/);
    expect(problems.join("\n")).toMatch(/refunds attacker.testnet/);
    expect(problems.join("\n")).toMatch(/takes 4000000/);
  });

  it("refuses a quote that promises under 97% of what's sent", () => {
    expect(quoteProblems({ ...quote, minAmountOut: "2910000" }, expected)).toEqual([]);
    expect(quoteProblems({ ...quote, minAmountOut: "2909999" }, expected)).toEqual([expect.stringMatching(/at least 2909999/)]);
  });

  it("refuses a dry quote, or one whose deposit address isn't a fresh implicit account", () => {
    expect(quoteProblems({ ...quote, depositAddress: null }, expected)).toEqual(["it has no fresh NEAR deposit address"]);
    expect(quoteProblems({ ...quote, depositAddress: "attacker.testnet" }, expected)).toEqual(["it has no fresh NEAR deposit address"]);
  });
});

describe("depositActions", () => {
  it("registers the deposit address and transfers in one transaction when it isn't registered", () => {
    expect(depositActions(DEPOSIT, AMOUNT, 1_250_000_000_000_000_000_000n)).toEqual([
      { method: "storage_deposit", args: { account_id: DEPOSIT, registration_only: true }, depositYocto: 1_250_000_000_000_000_000_000n, gasTgas: 30 },
      { method: "ft_transfer", args: { receiver_id: DEPOSIT, amount: AMOUNT }, depositYocto: 1n, gasTgas: 30 },
    ]);
  });

  it("only transfers when the address is already registered", () => {
    expect(depositActions(DEPOSIT, AMOUNT, null).map((a) => a.method)).toEqual(["ft_transfer"]);
  });

  it("refuses a named account, more than 5 USDC, or a malformed amount", () => {
    expect(() => depositActions("attacker.testnet", AMOUNT, null)).toThrow(/fresh deposit address/);
    expect(() => depositActions(DEPOSIT, "5000001", null)).toThrow(/5 USDC/);
    expect(() => depositActions(DEPOSIT, "0", null)).toThrow();
    expect(() => depositActions(DEPOSIT, "3.0", null)).toThrow();
  });
});

/** A fake clock that moves only when the code under test sleeps. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("waitForFinalStatus", () => {
  it("polls until a final status, reporting each change once", async () => {
    const answers: SwapStatus[] = ["PENDING_DEPOSIT", "PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"];
    const seen: [SwapStatus, number][] = [];
    const clock = fakeClock();
    const result = await waitForFinalStatus(async () => answers.shift()!, { ...clock, intervalMs: 1000, timeoutMs: 60_000, onStatus: (s, at) => seen.push([s, at]) });
    expect(result).toEqual({ status: "SUCCESS", at: 4000, final: true });
    expect(seen.map(([s]) => s)).toEqual(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"]);
  });

  it("treats REFUNDED and FAILED as final too", async () => {
    for (const end of ["REFUNDED", "FAILED"] as const) {
      expect((await waitForFinalStatus(async () => end, { ...fakeClock(), timeoutMs: 1000 })).status).toBe(end);
    }
  });

  it("rides out a failed read, and gives up with the last status when time runs out", async () => {
    let calls = 0;
    const flaky = async (): Promise<SwapStatus> => {
      calls += 1;
      if (calls === 2) throw new Error("fetch failed");
      return "PROCESSING";
    };
    const result = await waitForFinalStatus(flaky, { ...fakeClock(), intervalMs: 1000, timeoutMs: 5000 });
    expect(result).toEqual({ status: "PROCESSING", at: 5000, final: false });
  });
});

describe("waitForBalanceChange", () => {
  it("returns the first reading that differs, and when it came", async () => {
    const readings = [0, 0, 0, 1.9922];
    const clock = fakeClock();
    expect(await waitForBalanceChange(async () => readings.shift()!, 0, { ...clock, intervalMs: 2000, giveUpAt: () => 60_000 })).toEqual({ value: 1.9922, at: 6000 });
  });

  it("returns null when it never changes, checking the deadline each round so it can move", async () => {
    const clock = fakeClock();
    let deadline = 4000;
    const result = await waitForBalanceChange(
      async () => {
        if (clock.now() === 2000) deadline = 10_000;
        return 5;
      },
      5,
      { ...clock, intervalMs: 2000, giveUpAt: () => deadline },
    );
    expect(result).toBeNull();
    expect(clock.now()).toBe(10_000);
  });

  it("doesn't take a failed read for a change", async () => {
    let calls = 0;
    const result = await waitForBalanceChange(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("HTTP 429");
        return calls === 3 ? 2 : 0;
      },
      0,
      { ...fakeClock(), intervalMs: 1000, giveUpAt: () => 60_000 },
    );
    expect(result).toEqual({ value: 2, at: 2000 });
  });
});

describe("formatSummary", () => {
  it("prints every figure and public link, and no key", () => {
    const text = formatSummary({ quoteId: "q-1", depositAddress: DEPOSIT, nearTxHash: "HASH", status: "SUCCESS", balanceBefore: 0, balanceAfter: 1.9922, msToFinal: 41_300, msToBalance: 44_060 });
    expect(text).toContain("q-1");
    expect(text).toContain("https://testnet.nearblocks.io/txns/HASH");
    expect(text).toContain(`https://www.usetidepool.tech/v0/status?depositAddress=${DEPOSIT}`);
    expect(text).toContain("Hyperliquid before: 0 USDC");
    expect(text).toContain("Hyperliquid after:  1.9922 USDC");
    expect(text).toContain("Deposit to SUCCESS: 41.3 s");
    expect(text).toContain("Deposit to balance on Hyperliquid: 44.1 s");
    expect(text).not.toMatch(/ed25519:/);
  });

  it("says plainly what wasn't seen", () => {
    const text = formatSummary({ quoteId: "q", depositAddress: DEPOSIT, nearTxHash: "H", status: null, balanceBefore: 0, balanceAfter: null, msToFinal: null, msToBalance: null });
    expect(text).toContain("Tidepool status:    unknown");
    expect(text).toContain("Hyperliquid after:  unchanged");
    expect(text).toContain("Deposit to balance on Hyperliquid: not seen");
  });
});
