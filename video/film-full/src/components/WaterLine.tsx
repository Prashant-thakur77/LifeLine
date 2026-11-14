import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { P } from "../theme";

/** The signature transition: the paper sea. At a section change the water rises over the end of a scene
 *  ("out") and drains away at the start of the next ("in"), three cut-paper wave sheets drifting as it moves. */
const wave = (w: number, top: number, amp: number, period: number, phase: number) => {
  let d = `M ${-period} ${top}`;
  for (let x = -period; x < w + period; x += period) {
    const a = x + phase;
    d += ` C ${a + period / 6} ${top - amp} ${a + period / 3} ${top - amp} ${a + period / 2} ${top} C ${a + (2 * period) / 3} ${top + amp} ${a + (5 * period) / 6} ${top + amp} ${a + period} ${top}`;
  }
  return `${d} L ${w + period} 4000 L ${-period} 4000 Z`;
};

export const Sheets: React.FC<{ level: number; f: number; W: number; H: number }> = ({ level, f, W, H }) => (
  <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
    <path d={wave(W, level - 26, 22, 420, (f * 3) % 420)} fill={P.seaLight} />
    <path d={wave(W, level, 18, 300, -((f * 4.5) % 300))} fill={P.carbon} />
    <path d={wave(W, level + 30, 14, 360, (f * 2.2) % 360)} fill={P.seaDeep} />
  </svg>
);

export const WaterLine: React.FC<{ dir: "in" | "out"; dur: number; len?: number }> = ({ dir, dur, len = 0.55 }) => {
  const f = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const n = Math.round(len * fps);
  const start = dir === "in" ? 0 : dur - n;
  if (f < start || f > start + n) return null;
  const k = (f - start) / n;
  const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  // out: water rises from below the frame to above it; in: it falls from above to below.
  const level = dir === "out" ? H + 80 - e * (H + 200) : -120 + e * (H + 200);
  return (
    <AbsoluteFill style={{ pointerEvents: "none", zIndex: 8 }}>
      <Sheets level={level} f={f} W={W} H={H} />
    </AbsoluteFill>
  );
};
