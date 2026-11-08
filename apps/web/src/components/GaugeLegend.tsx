"use client";

import { formatHealth } from "../lib/format";

type Levels = { warn: number; trigger: number; target: number };

/** The user's levels, as a legend under the waterline. */
export function GaugeLegend({ levels }: { levels: Levels }) {
  return (
    <dl className="grid grid-cols-3 gap-2 text-center">
      <div className="rounded-xl border border-ink-600/70 bg-ink-850/80 px-2 py-2">
        <dt className="text-[11px] uppercase tracking-[0.1em] text-mist-400">Warn</dt>
        <dd className="num text-[15px] text-warn">{formatHealth(levels.warn)}</dd>
      </div>
      <div className="rounded-xl border border-ink-600/70 bg-ink-850/80 px-2 py-2">
        <dt className="text-[11px] uppercase tracking-[0.1em] text-mist-400">Rescue below</dt>
        <dd className="num text-[15px] text-rescue">{formatHealth(levels.trigger)}</dd>
      </div>
      <div className="rounded-xl border border-ink-600/70 bg-ink-850/80 px-2 py-2">
        <dt className="text-[11px] uppercase tracking-[0.1em] text-mist-400">Refill to</dt>
        <dd className="num text-[15px] text-safe">{formatHealth(levels.target)}</dd>
      </div>
    </dl>
  );
}
