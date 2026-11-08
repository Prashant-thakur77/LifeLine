import { describe, expect, it } from "vitest";
import type { RescueStory } from "../src/lib/replay";
import { REPLAY, hullY, replayBeats, settle, levelAt } from "../src/lib/waterline";

const story: RescueStory = {
  warn: { health: 1.7857, at: "2026-11-08T18:22:09.478Z" },
  trigger: { health: 1.4388, at: "2026-11-08T18:22:16.373Z" },
  restored: { health: 2.0062, at: "2026-11-08T18:22:20.373Z" },
  amount: "3.47 USDC",
  latencyMs: 5895,
  simulated: true,
  explanation: null,
  rulesBroken: 0,
};

describe("settle", () => {
  it("moves toward the target and arrives without overshooting", () => {
    let state = { value: 0, velocity: 0 };
    let max = 0;
    for (let i = 0; i < 240; i++) {
      state = settle(state, 1, 1 / 60);
      max = Math.max(max, state.value);
    }
    expect(max).toBeLessThanOrEqual(1);
    expect(state.value).toBeCloseTo(1, 3);
  });

  it("takes about a second to cover most of the way, so a level change reads as heavy", () => {
    let state = { value: 0, velocity: 0 };
    for (let i = 0; i < 30; i++) state = settle(state, 1, 1 / 60);
    expect(state.value).toBeGreaterThan(0.3);
    expect(state.value).toBeLessThan(0.85);
  });

  it("survives a long frame gap (a hidden tab) without flying past the target", () => {
    const state = settle({ value: 0, velocity: 0 }, 1, 5);
    expect(state.value).toBeLessThanOrEqual(1);
    expect(state.value).toBeGreaterThan(0.9);
  });
});

describe("replayBeats", () => {
  it("plays the recorded warning, the trigger, the throw and the refill, in that order, with the recorded values", () => {
    const beats = replayBeats(story);
    expect(beats.map((b) => b.kind)).toEqual(["warn", "trigger", "throw", "restored"]);
    expect(beats.map((b) => b.health)).toEqual([1.7857, 1.4388, 1.4388, 2.0062]);
    const times = beats.map((b) => b.atMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(beats.at(-1)!.atMs).toBe(REPLAY.totalMs - REPLAY.holdEndMs);
  });

  it("starts at the trigger when no warning was recorded", () => {
    const beats = replayBeats({ ...story, warn: null });
    expect(beats.map((b) => b.kind)).toEqual(["trigger", "throw", "restored"]);
    expect(beats[0]!.atMs).toBe(0);
  });
});

describe("levelAt", () => {
  it("holds each recorded value until the next beat, so the replay never shows a health that wasn't read", () => {
    const beats = replayBeats(story);
    expect(levelAt(beats, 0)).toBe(1.7857);
    expect(levelAt(beats, beats[1]!.atMs - 1)).toBe(1.7857);
    expect(levelAt(beats, beats[1]!.atMs)).toBe(1.4388);
    expect(levelAt(beats, beats[3]!.atMs + 10)).toBe(2.0062);
    expect(levelAt(beats, -5)).toBe(1.7857);
  });
});

describe("hullY", () => {
  it("puts liquidation at the top of the scale and lower health higher up the hull", () => {
    expect(hullY(1, 0.14)).toBeCloseTo(0.14);
    expect(hullY(4, 0.14)).toBeCloseTo(1);
    expect(hullY(1.44, 0.14)).toBeLessThan(hullY(1.79, 0.14));
    expect(hullY(1.79, 0.14)).toBeLessThan(hullY(2.0, 0.14));
  });
  it("draws no open positions at the bottom and pins below-liquidation readings to the top", () => {
    expect(hullY(Number.POSITIVE_INFINITY, 0.14)).toBe(1);
    expect(hullY(0.7, 0.14)).toBeCloseTo(0.14);
  });
});
