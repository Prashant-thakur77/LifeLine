import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Sheets } from "../components/WaterLine";
import { INOUT, OUT, ramp, rand } from "../lib/anim";
import { P, T } from "../theme";

/** Lifeline's world, as on its landing page: account health is a sea level against a load line printed on an
 *  orange hull. Falling health is rising water. "fall": the night the price drops. "rescue": a line is thrown
 *  from the reserve, a lifebuoy lands, the water drops back. "calm": the morning after. */
export type SeaProps = {
  mode: "fall" | "rescue" | "calm";
  sky?: "night" | "day";
  from: number; // health at the start
  to: number; // health at the end
  clock?: string; // "3:07"
  clockTo?: string;
  throwAt?: number; // seconds: the rescue line is thrown
  amount?: string; // "+3.47 USDC"
  tag?: string; // label on the reserve
  dur: number;
};

const LIQ = 1.0, TOP = 2.6;
/** The water's surface (y, px from the top) for a health: low health, high water. */
const levelFor = (h: number, H: number) => interpolate(h, [LIQ, TOP], [H * 0.34, H * 0.86], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
const MARKS = [
  { h: 1.0, label: "LIQUIDATION", c: P.danger },
  { h: 1.5, label: "RESCUE", c: P.stamp },
  { h: 1.8, label: "WARN", c: P.mark },
  { h: 2.0, label: "TARGET", c: P.okBright },
];

const Buoy: React.FC<{ size: number }> = ({ size }) => {
  const c = 2 * Math.PI * 8.5;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="#fffcf5" strokeWidth="5" />
      <circle cx="12" cy="12" r="8.5" fill="none" stroke={P.stamp} strokeWidth="5" strokeDasharray={`${c / 8} ${c / 8}`} transform="rotate(-22.5 12 12)" />
      <circle cx="12" cy="12" r="11.1" fill="none" stroke={P.ink} strokeWidth="1.1" />
      <circle cx="12" cy="12" r="5.9" fill="none" stroke={P.ink} strokeWidth="1.1" />
    </svg>
  );
};

export const Sea: React.FC<SeaProps> = ({ mode, sky = "night", from, to, clock, clockTo, throwAt = 1.2, amount, tag, dur }) => {
  const f = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const night = sky === "night";
  const t0 = Math.round(throwAt * fps);

  // Health over time: falls through the scene, or holds then recovers after the throw, or bobs.
  let h: number;
  if (mode === "fall") h = interpolate(f, [0, dur * 0.92], [from, to], { extrapolateRight: "clamp", easing: INOUT });
  else if (mode === "rescue") h = interpolate(f, [0, t0, t0 + 1.3 * fps], [from, from - 0.04, to], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: INOUT });
  else h = to + Math.sin(f / 22) * 0.02;
  const level = levelFor(h, H) + Math.sin(f / 14) * 4;

  const danger = h < 1.5;
  const close = mode === "fall" && h < 1.2;
  const pulse = close ? 0.5 + 0.5 * Math.sin(f / 3.2) : 0;
  const tone = h < 1.2 ? P.danger : h < 1.5 ? P.stamp : h < 1.8 ? P.mark : P.okBright;

  // Hull on the right; marks printed on it at their health levels.
  const hullX = W * 0.62, hullW = W * 0.3;

  // The throw: an arc from the reserve tag (top left of the hull) to the water by the hull.
  const tk = mode === "rescue" ? ramp(f, t0, Math.round(0.45 * fps)) : 0;
  const ax = W * 0.18, ay = H * 0.2;
  const bx = hullX - 140, by = level - 30;
  const cx = (ax + bx) / 2, cy = Math.min(ay, by) - 260;
  const bz = (k: number) => ({
    x: (1 - k) * (1 - k) * ax + 2 * (1 - k) * k * cx + k * k * bx,
    y: (1 - k) * (1 - k) * ay + 2 * (1 - k) * k * cy + k * k * by,
  });
  const buoy = bz(tk);
  const landed = mode === "calm" || (mode === "rescue" && f > t0 + 0.45 * fps);
  const splash = mode === "rescue" ? ramp(f, t0 + Math.round(0.45 * fps), Math.round(0.6 * fps)) : 0;

  const clockText = clockTo && mode !== "calm" ? (f > dur * 0.6 ? clockTo : clock) : clock;
  const stars = night ? Array.from({ length: 70 }, (_, i) => ({ x: rand(i) * W, y: rand(i + 99) * H * 0.55, r: 1 + rand(i + 7) * 2, tw: rand(i + 3) })) : [];

  return (
    <AbsoluteFill style={{ background: night ? `linear-gradient(180deg, ${P.night} 0%, #142257 70%, #1b2f75 100%)` : `linear-gradient(180deg, ${P.paper} 0%, ${P.paper2} 100%)` }}>
      {stars.map((s, i) => (
        <div key={i} style={{ position: "absolute", left: s.x, top: s.y, width: s.r, height: s.r, borderRadius: 9, background: "#fff7ea", opacity: 0.25 + 0.5 * Math.abs(Math.sin(f / 30 + s.tw * 6)) }} />
      ))}
      {/* The sun (or the moon): printed, slightly off register. */}
      <div style={{ position: "absolute", left: hullX + hullW * 0.55, top: H * 0.08 + Math.sin(f / 60) * 6, width: 210, height: 210, borderRadius: 999,
        background: night ? "#f3ead2" : P.mark, opacity: night ? 0.85 : 1, boxShadow: night ? "0 0 120px #f3ead244" : "8px 6px 0 #ff5a1f55" }} />

      {/* Hull with its load line. */}
      <div style={{ position: "absolute", left: hullX, top: H * 0.16, width: hullW, height: H, background: P.stamp, borderLeft: `6px solid ${P.ink}`, borderTop: `6px solid ${P.ink}`,
        boxShadow: "16px 0 0 #0b153333" }} />
      {MARKS.map((m) => {
        const y = levelFor(m.h, H);
        return (
          <div key={m.label} style={{ position: "absolute", left: hullX - 30, top: y - 3, width: hullW * 0.62, height: 6, background: m.c, boxShadow: `0 0 0 2px ${P.ink}` }}>
            <span style={{ position: "absolute", left: hullW * 0.62 + 16, top: -20, fontFamily: T.monoFont, fontWeight: 600, fontSize: 28, letterSpacing: 2, color: P.paper, whiteSpace: "nowrap",
              background: P.ink, padding: "2px 10px" }}>{m.label} · {m.h.toFixed(1)}</span>
          </div>
        );
      })}
      {/* The load-line disc (Plimsoll mark) on the hull. */}
      <div style={{ position: "absolute", left: hullX + 70, top: levelFor(1.5, H) - 70, width: 140, height: 140, borderRadius: 999, border: `8px solid ${P.paper}`, opacity: 0.9 }} />

      {/* Danger glow at the liquidation line. */}
      {close && <AbsoluteFill style={{ background: `radial-gradient(60% 40% at 70% ${(levelFor(1, H) / H) * 100}%, ${P.danger}${Math.round(40 + pulse * 70).toString(16)}, transparent)` }} />}

      {/* Reserve tag and the thrown line. */}
      {mode === "rescue" && (
        <>
          <div style={{ position: "absolute", left: ax - 40, top: ay - 70, fontFamily: T.monoFont, fontSize: 28, color: P.paper, background: P.ink, padding: "8px 16px",
            border: `3px solid ${P.ink}`, boxShadow: `5px 5px 0 ${P.stamp}`, opacity: ramp(f, 0, 12) }}>{tag ?? "Reserve · vault on NEAR"}</div>
          {tk > 0 && (
            <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
              <path d={`M ${ax} ${ay} Q ${cx} ${cy} ${buoy.x} ${buoy.y}`} stroke={P.ink} strokeWidth={5} fill="none" strokeDasharray={landed ? "0" : "14 10"} />
            </svg>
          )}
        </>
      )}

      <Sheets level={level} f={f} W={W} H={H} />

      {mode !== "fall" && (mode === "calm" || tk > 0) && (
        <div style={{ position: "absolute", left: (landed ? bx : buoy.x) - 70, top: (landed ? level - 70 + Math.sin(f / 9) * 8 : buoy.y - 70), rotate: `${landed ? Math.sin(f / 13) * 8 : tk * 540}deg` }}>
          <Buoy size={140} />
        </div>
      )}
      {splash > 0 && splash < 1 && Array.from({ length: 9 }, (_, i) => {
        const a = (-150 + i * 15) * (Math.PI / 180);
        const r = OUT(splash) * 170;
        return <div key={i} style={{ position: "absolute", left: bx + Math.cos(a) * r, top: level - 30 + Math.sin(a) * r + splash * splash * 120, width: 16, height: 16, borderRadius: 9, background: P.seaLight, opacity: 1 - splash }} />;
      })}
      {mode === "rescue" && amount && landed && (
        <div style={{ position: "absolute", left: bx - 120, top: level - 190, fontFamily: T.monoFont, fontWeight: 600, fontSize: 40, color: P.ink, background: P.okBright,
          padding: "6px 16px", border: `3px solid ${P.ink}`, opacity: ramp(f, t0 + Math.round(0.6 * fps), 10), translate: `0 ${(1 - ramp(f, t0 + Math.round(0.6 * fps), 14)) * 20}px` }}>{amount}</div>
      )}

      {/* Readout. */}
      <div style={{ position: "absolute", left: T.safeX, top: H * 0.3, color: night ? P.paper : P.ink }}>
        <div style={{ fontFamily: T.monoFont, fontSize: 30, letterSpacing: 6, opacity: 0.8 }}>HEALTH</div>
        <div style={{ fontFamily: T.monoFont, fontWeight: 300, fontSize: 210, lineHeight: 1, letterSpacing: -6, color: danger ? tone : night ? P.paper : P.ink,
          textShadow: close ? `0 0 ${20 + pulse * 40}px ${P.danger}` : undefined }}>{h.toFixed(2)}</div>
        <div style={{ marginTop: 16, display: "inline-block", fontFamily: T.monoFont, fontSize: 28, letterSpacing: 3, color: P.ink, background: tone, padding: "4px 14px",
          border: `3px solid ${P.ink}` }}>{h < 1.2 ? "ABOUT TO BE LIQUIDATED" : h < 1.5 ? "BELOW TRIGGER" : h < 1.8 ? "WATCH" : "SAFE"}</div>
      </div>
      {clockText && (
        <div style={{ position: "absolute", left: T.safeX, top: T.safeY + 40, fontFamily: T.monoFont, fontSize: 44, color: night ? P.paper : P.ink, letterSpacing: 4 }}>
          {clockText} <span style={{ fontSize: 30, opacity: 0.7 }}>AM</span>
        </div>
      )}
    </AbsoluteFill>
  );
};
