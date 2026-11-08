"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type PollState<T> = {
  data: T | undefined;
  error: Error | undefined;
  /** True until the first answer (or error) for the current key. */
  loading: boolean;
  /** When the last successful answer arrived, in ms. */
  updatedAt: number | undefined;
  refresh: () => void;
};

/**
 * Fetches when `key` changes, then every `intervalMs` (null fetches once). A failed
 * fetch keeps the last good data, so the page can say "this is old" instead of going
 * blank. Polling waits while the tab is hidden and catches up when it comes back.
 */
export function usePoll<T>(key: string | null, fetcher: () => Promise<T>, intervalMs: number | null): PollState<T> {
  const [state, setState] = useState<Omit<PollState<T>, "refresh">>({ data: undefined, error: undefined, loading: key !== null, updatedAt: undefined });
  const fetcherRef = useRef(fetcher);
  const tickRef = useRef<() => void>(() => {});

  // Declared before the polling effect, so the first fetch already sees this render's fetcher.
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    setState({ data: undefined, error: undefined, loading: key !== null, updatedAt: undefined });
    if (key === null) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;

    const schedule = () => {
      if (cancelled || intervalMs === null) return;
      clearTimeout(timer);
      timer = setTimeout(tick, intervalMs);
    };

    const tick = async () => {
      if (cancelled || inFlight) return;
      if (typeof document !== "undefined" && document.hidden && intervalMs !== null) return schedule();
      inFlight = true;
      try {
        const data = await fetcherRef.current();
        if (!cancelled) setState({ data, error: undefined, loading: false, updatedAt: Date.now() });
      } catch (error) {
        if (!cancelled) setState((prev) => ({ ...prev, error: error instanceof Error ? error : new Error(String(error)), loading: false }));
      } finally {
        inFlight = false;
        schedule();
      }
    };

    const onVisible = () => {
      if (!document.hidden) void tick();
    };

    tickRef.current = () => void tick();
    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, intervalMs]);

  const refresh = useCallback(() => tickRef.current(), []);
  return { ...state, refresh };
}

/** The current time, updated every `intervalMs`, for "12 s ago" labels and countdowns. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
