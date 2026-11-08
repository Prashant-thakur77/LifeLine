"use client";

import { formatHealth } from "../lib/format";

type Levels = { warn: number; trigger: number; target: number };

/** The user's levels, as a legend under the waterline. */
export function GaugeLegend({ levels }: { levels: Levels }) {
  return (
    <dl className="grid grid-cols-3 gap-2 text-center">
      <div className="rounded-lg border-2 border-ink bg-card px-2 py-2">
        <dt className="text-[11px] uppercase tracking-[0.1em] text-muted">Warn</dt>
        <dd className="num text-[15px] text-warn-ink">{formatHealth(levels.warn)}</dd>
      </div>
      <div className="rounded-lg border-2 border-ink bg-card px-2 py-2">
        <dt className="text-[11px] uppercase tracking-[0.1em] text-muted">Rescue below</dt>
        <dd className="num text-[15px] text-rescue-ink">{formatHealth(levels.trigger)}</dd>
      </div>
      <div className="rounded-lg border-2 border-ink bg-card px-2 py-2">
        <dt className="text-[11px] uppercase tracking-[0.1em] text-muted">Refill to</dt>
        <dd className="num text-[15px] text-safe-ink">{formatHealth(levels.target)}</dd>
      </div>
    </dl>
  );
}
