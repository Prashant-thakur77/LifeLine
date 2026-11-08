"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pollDelay } from "../lib/poll";

/** When someone last used the page. Polls slow down after 10 idle minutes, and catch up on the next touch. */
let lastActivity = Date.now();
const idleListeners = new Set<() => void>();
if (typeof window !== "undefined") {
  const wake = () => {
    const wasIdle = pollDelay(1, Date.now() - lastActivity) !== 1;
    lastActivity = Date.now();
    if (wasIdle) for (const listener of idleListeners) listener();
  };
  for (const event of ["pointerdown", "pointermove", "keydown", "scroll", "touchstart", "focus"]) {
    window.addEventListener(event, wake, { passive: true });
  }
}

export type PollState<T> = {
  data: T | undefined;
  error: Error | undefined;
  /** True until the first answer (or error) for the current key. */
  loading: boolean;
  /** When the last successful answer arrived, in ms, by this browser's clock. */
  updatedAt: number | undefined;
  /** Fetches now; if a fetch is already running, fetches again right after it. */
  refresh: () => void;
};

type Stored<T> = { key: string | null; data: T | undefined; error: Error | undefined; loading: boolean; updatedAt: number | undefined };

const empty = <T,>(key: string | null): Stored<T> => ({ key, data: undefined, error: undefined, loading: key !== null, updatedAt: undefined });

/**
 * Fetches when `key` changes, then every `intervalMs` (null fetches once). A failed
 * fetch keeps the last good data, so the page can say "this is old" instead of going
 * blank. Polling waits while the tab is hidden and catches up when it comes back, and
 * slows to once a minute after 10 minutes with nobody using the page.
 *
 * Data is stored with the key it was fetched for, and only returned for that key: on
 * the render where the key changes (say, a different account), the old account's data
 * is already gone rather than lingering until an effect clears it.
 */
export function usePoll<T>(key: string | null, fetcher: () => Promise<T>, intervalMs: number | null): PollState<T> {
  const [stored, setStored] = useState<Stored<T>>(() => empty<T>(key));
  const fetcherRef = useRef(fetcher);
  const tickRef = useRef<() => void>(() => {});

  // Declared before the polling effect, so the first fetch already sees this render's fetcher.
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    setStored(empty<T>(key));
    if (key === null) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let again = false;

    const schedule = () => {
      if (cancelled || intervalMs === null) return;
      clearTimeout(timer);
      timer = setTimeout(tick, pollDelay(intervalMs, Date.now() - lastActivity));
    };

    const tick = async () => {
      if (cancelled) return;
      if (inFlight) {
        again = true;
        return;
      }
      if (typeof document !== "undefined" && document.hidden && intervalMs !== null) return schedule();
      inFlight = true;
      try {
        const data = await fetcherRef.current();
        if (!cancelled) setStored({ key, data, error: undefined, loading: false, updatedAt: Date.now() });
      } catch (error) {
        if (!cancelled) {
          const failure = error instanceof Error ? error : new Error(String(error));
          setStored((prev) => (prev.key === key ? { ...prev, error: failure, loading: false } : { ...empty<T>(key), error: failure, loading: false }));
        }
      } finally {
        inFlight = false;
        if (again) {
          again = false;
          void tick();
        } else schedule();
      }
    };

    const onVisible = () => {
      if (!document.hidden) void tick();
    };

    tickRef.current = () => void tick();
    void tick();
    document.addEventListener("visibilitychange", onVisible);
    const onWake = () => void tick();
    idleListeners.add(onWake);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      idleListeners.delete(onWake);
    };
  }, [key, intervalMs]);

  const refresh = useCallback(() => tickRef.current(), []);
  const current = stored.key === key ? stored : empty<T>(key);
  return { data: current.data, error: current.error, loading: current.loading, updatedAt: current.updatedAt, refresh };
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
