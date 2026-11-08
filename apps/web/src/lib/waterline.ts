import { GAUGE_MAX, GAUGE_MIN, healthToFraction } from "./gauge";
import type { RescueStory } from "./replay";

/**
 * Motion for the waterline on the landing page. The level is a health reading drawn as
 * a sea level against the load line; it moves like heavy water, settling without a
 * bounce, because a health that overshoots on screen would show a number nobody read.
 */

export type Spring = { value: number; velocity: number };

/** Angular frequency of the critically damped spring: about a second to cover most of a move. */
const OMEGA = 4.2;

/**
 * One step of a critically damped spring toward `target`, solved exactly so any frame
 * length is stable: a hidden tab that comes back after seconds lands near the target
 * instead of flying past it.
 */
export function settle(state: Spring, target: number, dtSeconds: number): Spring {
  const dt = Math.max(0, dtSeconds);
  const x0 = state.value - target;
  const v0 = state.velocity;
  const decay = Math.exp(-OMEGA * dt);
  const c = v0 + OMEGA * x0;
  const x = (x0 + c * dt) * decay;
  const v = (v0 - OMEGA * c * dt) * decay;
  return { value: target + x, velocity: v };
}

export type BeatKind = "warn" | "trigger" | "throw" | "restored";
export type Beat = { kind: BeatKind; health: number; atMs: number; at: string };

/** The replay's tempo: slow while the water rises, one fast throw, then a heavy fall back. */
export const REPLAY = {
  riseMs: 2400, // warning to trigger
  pauseMs: 500, // the keeper reads, decides, quotes
  throwMs: 240, // the line snaps out
  landMs: 380, // the line pulls taut and the refill lands; the water starts to fall
  holdEndMs: 2600, // the water settles and holds before the page goes live
  get totalMs() {
    return this.riseMs + this.pauseMs + this.throwMs + this.landMs + this.holdEndMs;
  },
};

/**
 * The recorded moments of the last rescue, on the replay's clock. Every health value is
 * one the keeper actually read; the times are compressed, and the page says so.
 */
export function replayBeats(story: RescueStory): Beat[] {
  const beats: Beat[] = [];
  let t = 0;
  if (story.warn) {
    beats.push({ kind: "warn", health: story.warn.health, atMs: t, at: story.warn.at });
    t += REPLAY.riseMs;
  }
  beats.push({ kind: "trigger", health: story.trigger.health, atMs: t, at: story.trigger.at });
  t += REPLAY.pauseMs;
  beats.push({ kind: "throw", health: story.trigger.health, atMs: t, at: story.trigger.at });
  t += REPLAY.throwMs + REPLAY.landMs;
  beats.push({ kind: "restored", health: story.restored.health, atMs: t, at: story.restored.at });
  return beats;
}

/** The recorded health in force at replay time `ms`: each value holds until the next beat. */
export function levelAt(beats: readonly Beat[], ms: number): number {
  let level = beats[0]?.health ?? Number.NaN;
  for (const beat of beats) {
    if (beat.atMs <= ms) level = beat.health;
    else break;
  }
  return level;
}

/**
 * Where on the hull a health sits, from 0 (top) to 1 (bottom): liquidation at
 * `scaleTop`, `scaleMax` (4.0 unless a short panel asks for less) and above at the bottom. Falling health is rising water. No open
 * positions (Infinity) draws the sea at the bottom; NaN is the caller's to refuse.
 */
export function hullY(health: number, scaleTop: number, scaleMax: number = GAUGE_MAX): number {
  const f =
    health >= scaleMax ? 1 : health <= GAUGE_MIN ? 0 : scaleMax === GAUGE_MAX ? healthToFraction(health) : Math.log(health) / Math.log(scaleMax);
  return scaleTop + (1 - scaleTop) * f;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One cut-paper wave: a closed path whose top edge rises and falls once per `period`,
 * drawn one period wider than `width` and down to `height`, so sliding it left by one
 * period loops seamlessly. Each period starts and ends at `top`.
 */
export function wavePath(o: { width: number; height: number; period: number; amp: number; top: number }): string {
  const { width, height, period, amp, top } = o;
  const k = amp * 1.33;
  const periods = Math.ceil((width + period) / period);
  let d = `M 0 ${r2(top)}`;
  for (let i = 0; i < periods; i++) {
    const x = i * period;
    d += ` C ${r2(x + period / 6)} ${r2(top - k)} ${r2(x + period / 3)} ${r2(top - k)} ${r2(x + period / 2)} ${r2(top)}`;
    d += ` C ${r2(x + (2 * period) / 3)} ${r2(top + k)} ${r2(x + (5 * period) / 6)} ${r2(top + k)} ${r2(x + period)} ${r2(top)}`;
  }
  const end = periods * period;
  return `${d} L ${end} ${r2(height)} L 0 ${r2(height)} Z`;
}
