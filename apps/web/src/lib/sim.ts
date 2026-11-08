import { formatCountdown } from "./format";

/**
 * While the sim rests between drops, its next alarm is the start of the next drop. A
 * drop in progress ticks every minute, so anything over ~70 s away means it's resting.
 * Returns null when the keeper isn't resting or the time can't be read.
 */
export function simRestCountdown(nextAlarmAt: string | null | undefined, nowMs: number): string | null {
  if (!nextAlarmAt) return null;
  const at = Date.parse(nextAlarmAt);
  if (Number.isNaN(at)) return null;
  const wait = at - nowMs;
  if (wait <= 70_000) return null;
  return formatCountdown(wait);
}
