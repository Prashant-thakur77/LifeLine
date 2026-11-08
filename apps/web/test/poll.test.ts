import { describe, expect, it } from "vitest";
import { IDLE_AFTER_MS, IDLE_POLL_MS, pollDelay } from "../src/lib/poll";

describe("pollDelay", () => {
  it("polls at the asked pace while someone is using the page", () => {
    expect(pollDelay(5_000, 0)).toBe(5_000);
    expect(pollDelay(5_000, IDLE_AFTER_MS - 1)).toBe(5_000);
  });

  it("slows to once a minute once nobody has touched the page for 10 minutes", () => {
    expect(IDLE_AFTER_MS).toBe(10 * 60_000);
    expect(pollDelay(5_000, IDLE_AFTER_MS)).toBe(IDLE_POLL_MS);
    expect(IDLE_POLL_MS).toBe(60_000);
  });

  it("never speeds up a poll that was already slower than that", () => {
    expect(pollDelay(120_000, IDLE_AFTER_MS * 3)).toBe(120_000);
  });
});
