/** Counts in this Worker's memory: how many it may still do this minute and in the last 24 hours. */
export function createBudget({ perMinute, perDay }: { perMinute: number; perDay: number }) {
  let used: number[] = [];
  return (now: number): boolean => {
    used = used.filter((at) => now - at < 86_400_000);
    if (used.length >= perDay || used.filter((at) => now - at < 60_000).length >= perMinute) return false;
    used.push(now);
    return true;
  };
}
