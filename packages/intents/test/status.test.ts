import { describe, expect, it } from "vitest";
import { describeStatus, FINAL_STATUSES, waitForFinal } from "../src/status";
import { SWAP_STATUSES, type SwapStatus } from "../src/types";

function scripted(answers: (SwapStatus | Error)[]) {
  let nowMs = 0;
  const seen: SwapStatus[] = [];
  return {
    seen,
    options: {
      getStatus: async () => {
        const next = answers.length > 1 ? answers.shift() : answers[0];
        if (next instanceof Error) throw next;
        return next as SwapStatus;
      },
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
      onStatus: (status: SwapStatus) => seen.push(status),
    },
  };
}

describe("waitForFinal", () => {
  it("follows a swap through to SUCCESS, reporting each new status once", async () => {
    const { options, seen } = scripted(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "PROCESSING", "SUCCESS"]);
    expect(await waitForFinal("dep-1", options)).toEqual({ status: "SUCCESS", final: true });
    expect(seen).toEqual(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"]);
  });

  it.each(["REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"] as const)("stops at %s", async (end) => {
    const { options } = scripted(["PROCESSING", end, "SUCCESS"]);
    expect(await waitForFinal("dep-1", options)).toEqual({ status: end, final: true });
  });

  it("keeps going through a failed poll, so one network blip isn't read as a failure", async () => {
    const { options } = scripted(["PROCESSING", new Error("timeout"), "SUCCESS"]);
    expect(await waitForFinal("dep-1", options)).toEqual({ status: "SUCCESS", final: true });
  });

  it("gives up after the timeout and says the last status it saw", async () => {
    const { options } = scripted(["PROCESSING"]);
    expect(await waitForFinal("dep-1", { ...options, timeoutMs: 30_000, intervalMs: 5_000 })).toEqual({
      status: "PROCESSING",
      final: false,
    });
  });

  it("reports no status at all if it never got one", async () => {
    const { options } = scripted([new Error("down")]);
    expect(await waitForFinal("dep-1", { ...options, timeoutMs: 10_000 })).toEqual({ status: null, final: false });
  });
});

describe("describeStatus", () => {
  it("has a different plain message for every 1Click status", () => {
    const messages = SWAP_STATUSES.map(describeStatus);
    expect(new Set(messages).size).toBe(SWAP_STATUSES.length);
    for (const message of messages) expect(message).toMatch(/^[A-Z].+\.$/);
  });

  it("tells the user what to do when the deposit was too small", () => {
    expect(describeStatus("INCOMPLETE_DEPOSIT")).toMatch(/less than the quote/);
  });

  it("treats exactly SUCCESS, REFUNDED, FAILED and INCOMPLETE_DEPOSIT as final", () => {
    expect([...FINAL_STATUSES].sort()).toEqual(["FAILED", "INCOMPLETE_DEPOSIT", "REFUNDED", "SUCCESS"]);
  });
});
