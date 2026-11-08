/** A page left open on a screen nobody is looking at stops counting against the keeper's free plan. */
export const IDLE_AFTER_MS = 10 * 60_000;
export const IDLE_POLL_MS = 60_000;

/** How long to wait before the next poll, given how long ago someone last used the page. */
export function pollDelay(intervalMs: number, idleForMs: number): number {
  return idleForMs >= IDLE_AFTER_MS ? Math.max(intervalMs, IDLE_POLL_MS) : intervalMs;
}
