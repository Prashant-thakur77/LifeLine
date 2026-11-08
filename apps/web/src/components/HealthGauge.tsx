"use client";

import { useId } from "react";
import { formatHealth } from "../lib/format";
import { DIAL, dialArc, dialBands, dialPoint, healthToFraction, type Reading, type Zone } from "../lib/gauge";
import { cx } from "./ui";

const ZONE_COLOR: Record<Zone, string> = {
  safe: "var(--color-safe)",
  warn: "var(--color-warn)",
  rescue: "var(--color-rescue)",
  liquidation: "var(--color-danger)",
  none: "var(--color-mist-300)",
  unknown: "var(--color-warn)",
  stale: "var(--color-warn)",
};

const BAND_COLOR = { rescue: "var(--color-rescue)", warn: "var(--color-warn)", safe: "var(--color-safe)" } as const;

type Levels = { warn: number; trigger: number; target: number };

/**
 * The dial. Bands show where the user's own levels sit (rescue below trigger, warn up
 * to the warn line, safe above); the needle shows health now. A reading that can't be
 * trusted draws hatched bands and no needle, so it can never pass for safe.
 */
export function HealthGauge({ reading, levels, compact = false }: { reading: Reading | null; levels: Levels; compact?: boolean }) {
  // Only characters that are safe inside url(#…), whatever format React's ids take.
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const zone: Zone = reading?.zone ?? "unknown";
  const untrusted = reading === null || zone === "unknown" || zone === "stale";
  const showNeedle = reading !== null && !untrusted && zone !== "none" && reading.health !== null;
  const fraction = showNeedle ? healthToFraction(reading.health!) : 0;
  const angle = DIAL.startDeg + fraction * DIAL.sweepDeg;
  const color = ZONE_COLOR[zone];
  const bands = dialBands(levels);
  const strokeWidth = 16;

  const tick = (level: number, inner: number, outer: number) => {
    const f = healthToFraction(level);
    const a = dialPoint(DIAL, f, DIAL.r - inner);
    const b = dialPoint(DIAL, f, DIAL.r + outer);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, f };
  };
  const label = (level: number, radius: number) => dialPoint(DIAL, healthToFraction(level), radius);

  const triggerTick = tick(levels.trigger, 12, 14);
  const warnTick = tick(levels.warn, 12, 14);
  const targetTick = tick(levels.target, 12, 4);
  const triggerLabel = label(levels.trigger, DIAL.r + 28);
  const warnLabel = label(levels.warn, DIAL.r + 28);
  const targetLabel = label(levels.target, DIAL.r - 38);
  const start = dialPoint(DIAL, 0, DIAL.r + 26);
  const end = dialPoint(DIAL, 1, DIAL.r + 26);

  const readout = reading === null ? "—" : untrusted ? "—" : formatHealth(reading.health);
  const headline = reading === null ? "Loading" : reading.headline;

  return (
    <div className={cx("relative mx-auto w-full", compact ? "max-w-[300px]" : "max-w-[420px]")}>
      <svg viewBox="0 0 320 262" className="w-full overflow-visible" role="img" aria-label={`Health ${readout}. ${headline}.`}>
        <defs>
          <pattern id={`hatch-${id}`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="8" height="8" fill="var(--color-ink-700)" />
            <rect width="3" height="8" fill="rgb(244 182 63 / 0.35)" />
          </pattern>
          <filter id={`glow-${id}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>

        {/* Track */}
        <path d={dialArc(DIAL, 0, 1)} stroke="var(--color-ink-700)" strokeWidth={strokeWidth + 6} fill="none" strokeLinecap="round" />

        {/* Bands */}
        {untrusted ? (
          <path d={dialArc(DIAL, 0, 1)} stroke={`url(#hatch-${id})`} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" />
        ) : (
          bands.map((band) => {
            const active = band.zone === zone || (zone === "liquidation" && band.zone === "rescue");
            return (
              <path
                key={band.zone}
                d={dialArc(DIAL, band.from, band.to)}
                stroke={BAND_COLOR[band.zone]}
                strokeOpacity={zone === "none" ? 0.14 : active ? 0.62 : 0.17}
                strokeWidth={strokeWidth}
                fill="none"
                style={{ transition: "stroke-opacity 600ms ease" }}
              />
            );
          })
        )}

        {/* Liquidation end */}
        <circle cx={dialPoint(DIAL, 0).x} cy={dialPoint(DIAL, 0).y} r={4} fill="var(--color-danger)" />

        {/* Level ticks */}
        {[triggerTick, warnTick].map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke="var(--color-paper)" strokeOpacity={untrusted ? 0.35 : 0.8} strokeWidth={2} />
        ))}
        <line x1={targetTick.x1} y1={targetTick.y1} x2={targetTick.x2} y2={targetTick.y2} stroke="var(--color-safe)" strokeOpacity={untrusted ? 0.35 : 0.9} strokeWidth={2} strokeDasharray="3 2" />

        <g className="num" fontSize="11" fill="var(--color-mist-300)">
          <text x={triggerLabel.x} y={triggerLabel.y} textAnchor="middle" dominantBaseline="middle" fill="var(--color-rescue)">
            {formatHealth(levels.trigger)}
          </text>
          <text x={warnLabel.x} y={warnLabel.y} textAnchor="middle" dominantBaseline="middle" fill="var(--color-warn)">
            {formatHealth(levels.warn)}
          </text>
          {!compact ? (
            <text x={targetLabel.x} y={targetLabel.y} textAnchor="middle" dominantBaseline="middle" fill="var(--color-safe)" fillOpacity="0.85">
              {formatHealth(levels.target)}
            </text>
          ) : null}
          <text x={start.x - 4} y={start.y + 6} textAnchor="middle" fill="var(--color-danger)">
            1.0
          </text>
          <text x={end.x + 4} y={end.y + 6} textAnchor="middle">
            4.0+
          </text>
        </g>

        {/* Needle */}
        {showNeedle ? (
          <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: `${DIAL.cx}px ${DIAL.cy}px`, transition: "transform 800ms cubic-bezier(0.2, 0.8, 0.2, 1)" }}>
            <line x1={DIAL.cx + DIAL.r - 17} y1={DIAL.cy} x2={DIAL.cx + DIAL.r + 11} y2={DIAL.cy} stroke={color} strokeWidth={8} strokeLinecap="round" filter={`url(#glow-${id})`} opacity={0.7} />
            <line x1={DIAL.cx + DIAL.r - 17} y1={DIAL.cy} x2={DIAL.cx + DIAL.r + 11} y2={DIAL.cy} stroke="var(--color-paper)" strokeWidth={3.5} strokeLinecap="round" />
          </g>
        ) : null}

        {/* Readout */}
        <text x={DIAL.cx} y={DIAL.cy - 2} textAnchor="middle" className="num" fontSize={compact ? 58 : 64} fontWeight={500} fill={untrusted ? "var(--color-mist-300)" : "var(--color-paper)"}>
          {readout}
        </text>
        <text x={DIAL.cx} y={DIAL.cy + 32} textAnchor="middle" fontSize="13" fontWeight={600} letterSpacing="0.14em" fill={color} style={{ textTransform: "uppercase" }}>
          {headline}
        </text>
      </svg>
      {zone === "rescue" || zone === "liquidation" ? (
        <span className="pointer-events-none absolute inset-x-[18%] top-[22%] -z-10 aspect-square rounded-full bg-rescue/15 blur-3xl animate-pulse-soft" aria-hidden />
      ) : null}
    </div>
  );
}

/** The levels as a legend under the dial. */
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
