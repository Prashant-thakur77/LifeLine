import type { HealthResponse, HealthSnapshot, Policy } from "@lifeline/shared";
import { formatHealth, formatUsd, timeAgo } from "./format";

/** The dial runs from liquidation (1.0) to 4.0, the highest target a policy allows. */
export const GAUGE_MIN = 1;
export const GAUGE_MAX = 4;

/**
 * Where a health value sits on the dial, from 0 to 1. The scale is logarithmic, so the
 * range where decisions happen (1.2 to 2.5) gets most of the arc instead of a sliver.
 * Above 4.0, and no positions (Infinity), pin to the end; below 1.0 pins to the start.
 */
export function healthToFraction(health: number): number {
  if (Number.isNaN(health)) return 0;
  if (health >= GAUGE_MAX) return 1;
  if (health <= GAUGE_MIN) return 0;
  return Math.log(health / GAUGE_MIN) / Math.log(GAUGE_MAX / GAUGE_MIN);
}

export type Zone = "unknown" | "stale" | "none" | "liquidation" | "rescue" | "warn" | "safe";

export type Reading = {
  zone: Zone;
  /** The health to draw, or null when there is nothing trustworthy to draw. */
  health: number | null;
  snapshot: HealthSnapshot | null;
  policy: Policy | null;
  ageMs: number | null;
  paused: boolean;
  headline: string;
  detail: string;
};

/** Older than this, a reading isn't shown as current. The keeper reads every 5 s. */
export const STALE_AFTER_MS = 60_000;

/**
 * The hosted sim rests 15 minutes between price drops (apps/keeper host.ts SIM_REST_MS)
 * and reads nothing meanwhile. Its readings are pretend, so the demo shows the last one
 * through a rest, with a note saying so, and only calls it stale well past that.
 */
export const SIM_STALE_AFTER_MS = 20 * 60_000;

/**
 * Turns a keeper health response into what the gauge shows. The rule that matters: a
 * reading that is missing, unknown, stale or ambiguous never comes out as "safe".
 *
 * Staleness is checked two ways, because the browser's clock and the keeper's can
 * disagree: by the reading's own time, and by `receivedAtMs`, when this browser last
 * heard from the keeper at all. A reading stamped well in the future is also refused.
 */
export function classifyHealth(response: HealthResponse | null, nowMs: number, staleAfterMs = STALE_AFTER_MS, receivedAtMs?: number): Reading {
  const policy = response?.policy ?? null;
  const paused = policy?.paused ?? false;
  const snapshotJson = response?.snapshot ?? null;

  if (response === null || response.status !== "ok" || snapshotJson === null) {
    return {
      zone: "unknown",
      health: null,
      snapshot: null,
      policy,
      ageMs: null,
      paused,
      headline: "Unknown",
      detail: "Lifeline can't read this Hyperliquid account right now. Don't treat it as safe.",
    };
  }

  const snapshot: HealthSnapshot = { ...snapshotJson, health: snapshotJson.health ?? Number.POSITIVE_INFINITY };
  const at = Date.parse(snapshot.at);
  const rawAge = Number.isNaN(at) ? null : nowMs - at;
  const ageMs = rawAge === null ? null : Math.max(0, rawAge);
  const base = { snapshot, policy, ageMs, paused };
  const silentMs = receivedAtMs === undefined ? 0 : nowMs - receivedAtMs;

  if (rawAge === null || rawAge > staleAfterMs || rawAge < -staleAfterMs || silentMs > staleAfterMs) {
    const why =
      silentMs > staleAfterMs
        ? `The keeper hasn't answered since ${timeAgo(new Date(receivedAtMs!).toISOString(), nowMs)}.`
        : rawAge === null || rawAge < -staleAfterMs
          ? "The last reading's time can't be trusted."
          : `The last reading is from ${timeAgo(snapshot.at, nowMs)}.`;
    return { ...base, zone: "stale", health: null, headline: "Stale", detail: `${why} Don't treat it as safe until a fresh one arrives.` };
  }

  // No maintenance margin with open positions means isolated-only positions, which a
  // top-up can't protect. The keeper reports that as unknown; this catches it anyway.
  if (!Number.isFinite(snapshot.health) || snapshot.maintenanceMarginUsed <= 0) {
    if (snapshot.positions.length > 0) {
      return {
        ...base,
        zone: "unknown",
        health: null,
        headline: "Unknown",
        detail: "These positions use no cross margin, so a top-up can't protect them. Don't treat them as safe.",
      };
    }
    return {
      ...base,
      zone: "none",
      health: Number.POSITIVE_INFINITY,
      headline: "No open positions",
      detail: "Nothing to protect right now. Lifeline keeps watching.",
    };
  }

  const health = snapshot.health;
  const trigger = policy?.trigger ?? 1.5;
  const warn = policy?.warn ?? 1.8;
  const target = policy?.target ?? 2.0;
  const pausedNote = paused ? " Rescues are paused, so nothing will be sent until you unpause." : "";

  if (health <= GAUGE_MIN) {
    return {
      ...base,
      zone: "liquidation",
      health,
      headline: "At liquidation",
      detail: `Health ${formatHealth(health)} is at Hyperliquid's liquidation level.${pausedNote}`,
    };
  }
  if (health < trigger) {
    return {
      ...base,
      zone: "rescue",
      health,
      headline: paused ? "Below trigger, paused" : "Rescue zone",
      detail: paused
        ? `Below your trigger of ${formatHealth(trigger)}, but rescues are paused. Add margin yourself or unpause.`
        : `Below your trigger of ${formatHealth(trigger)}. The keeper tops your margin back up to ${formatHealth(target)}.`,
    };
  }
  if (health < warn) {
    return {
      ...base,
      zone: "warn",
      health,
      headline: "Watch",
      detail: `Below your warn line of ${formatHealth(warn)}. A rescue fires below ${formatHealth(trigger)}.${pausedNote}`,
    };
  }
  return {
    ...base,
    zone: "safe",
    health,
    headline: paused ? "Safe, paused" : "Safe",
    detail: paused
      ? "Rescues are paused, so Lifeline only watches."
      : `Lifeline steps in below ${formatHealth(trigger)}, with ${formatUsd(cushionUsd(snapshot, trigger))} of losses to go.`,
  };
}

/**
 * How much the account can lose before health reaches `level`, in USD:
 * accountValue − level × maintenanceMarginUsed. Negative means it is already below.
 */
export function cushionUsd(snapshot: Pick<HealthSnapshot, "accountValue" | "maintenanceMarginUsed">, level: number): number {
  return snapshot.accountValue - level * snapshot.maintenanceMarginUsed;
}

/** What a rescue must add to reach the target, before fees: target × MMU − accountValue. */
export function rescueNeededUsd(snapshot: Pick<HealthSnapshot, "accountValue" | "maintenanceMarginUsed">, target: number): number {
  return Math.max(0, target * snapshot.maintenanceMarginUsed - snapshot.accountValue);
}
