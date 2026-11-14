import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { OUT, pop, ramp } from "../lib/anim";
import { P, T } from "../theme";

/** The real mainnet run, from research/mainnet/RESULTS.md: a clock runs from the NEAR deposit to the USDC landing in
 *  a Hyperliquid perps balance, and each real step stamps in at its own second. */
export type MainnetRunProps = {
  when: string;
  steps: { t: number; label: string; detail: string }[];
  landed: number;
  amount: string;
  cost: string;
  quote: string;
  dur: number;
};

export const MainnetRun: React.FC<MainnetRunProps> = ({ when, steps, landed, amount, cost, quote, dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const runFrames = Math.max(fps * 2, dur - fps * 2.2);
  // The scene's clock is the run's clock, compressed: 0 → the landing second, then it holds.
  const runT = interpolate(f, [fps * 0.6, runFrames], [0, landed], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const frameOf = (t: number) => fps * 0.6 + (t / landed) * (runFrames - fps * 0.6);
  const done = runT >= landed - 0.01;
  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${P.night}, #101c4a)`, padding: `${T.safeY}px ${T.safeX}px`, color: P.paper }}>
      <div style={{ display: "inline-block", alignSelf: "flex-start", fontFamily: T.monoFont, fontWeight: 600, fontSize: 28, letterSpacing: 5, color: P.ink, background: P.okBright,
        padding: "6px 16px", border: `3px solid ${P.paper}`, opacity: ramp(f, 0, 10) }}>REAL MONEY · NEAR MAINNET · {when}</div>
      <div style={{ display: "flex", marginTop: 40, gap: 70 }}>
        <div style={{ width: 640 }}>
          <div style={{ fontFamily: T.monoFont, fontSize: 30, letterSpacing: 4, opacity: 0.8 }}>DEPOSIT ON NEAR → MARGIN ON HYPERLIQUID</div>
          <div style={{ fontFamily: T.monoFont, fontWeight: 300, fontSize: 230, lineHeight: 1, letterSpacing: -8, color: done ? P.okBright : P.paper, marginTop: 10 }}>
            {runT.toFixed(1)}<span style={{ fontSize: 90 }}>s</span>
          </div>
          <div style={{ marginTop: 26, fontFamily: T.font, fontWeight: 700, fontSize: 46, opacity: ramp(f, Math.round(frameOf(landed)), 12),
            translate: `0 ${(1 - OUT(ramp(f, Math.round(frameOf(landed)), 14))) * 20}px` }}>
            {amount} in a Hyperliquid perps balance that held 0
          </div>
          <div style={{ marginTop: 18, fontFamily: T.monoFont, fontSize: 28, opacity: ramp(f, Math.round(frameOf(landed)) + 10, 12) * 0.85 }}>{cost}</div>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, marginTop: 10 }}>
          {steps.map((s, i) => {
            const a = Math.round(frameOf(Math.min(s.t, landed)));
            const k = pop(f, fps, a, 13);
            const hit = s.t <= landed + 0.01 && Math.abs(s.t - landed) < 0.01;
            return (
              <div key={s.label} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 22, alignItems: "baseline", padding: "16px 22px", borderRadius: 12,
                background: hit ? P.okBright : "#fff7ea", color: P.ink, border: `4px solid ${P.ink}`, boxShadow: `6px 6px 0 ${hit ? P.paper : P.stamp}`,
                opacity: Math.min(1, k * 1.3), scale: `${0.9 + 0.1 * k}` }}>
                <span style={{ fontFamily: T.monoFont, fontWeight: 600, fontSize: 32 }}>{s.t.toFixed(1)} s</span>
                <span>
                  <span style={{ display: "block", fontFamily: T.font, fontWeight: 750, fontSize: 36 }}>{s.label}</span>
                  <span style={{ display: "block", fontFamily: T.monoFont, fontSize: 23, color: hit ? P.ink : P.ink3, marginTop: 4 }}>{s.detail}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ position: "absolute", left: T.safeX, bottom: 150, fontFamily: T.monoFont, fontSize: 24, opacity: ramp(f, fps, 12) * 0.75 }}>
        1Click quote {quote} · signed by 1Click's own key · research/mainnet/RESULTS.md
      </div>
    </AbsoluteFill>
  );
};
