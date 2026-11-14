import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { OUT, pop, ramp } from "../lib/anim";
import { P, T } from "../theme";

/** Two printed boards in the site's style.
 *  "compare": the usual fix against Lifeline, row by row; Lifeline's side lands with a mint check.
 *  "pillars": why it has to be NEAR: one card per piece of NEAR the product can't exist without, each with what it does here. */
export type BoardProps = {
  mode: "compare" | "pillars";
  title: string;
  kicker?: string;
  left?: string;
  right?: string;
  rows?: { left: string; right: string }[];
  cards?: { name: string; does: string }[];
  start?: number;
  each?: number;
  dur: number;
};

const CARD_COLORS = [P.carbon, P.mark, P.stamp, P.okBright];

export const Board: React.FC<BoardProps> = ({ mode, title, kicker, left, right, rows = [], cards = [], start = 0.6, each = 1.4 }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = (i: number) => Math.round((start + i * each) * fps);
  return (
    <AbsoluteFill style={{ background: P.paper, padding: `${T.safeY}px ${T.safeX}px`, color: P.ink }}>
      {kicker && <div style={{ fontFamily: T.monoFont, fontSize: 28, letterSpacing: 5, color: P.stampText, opacity: ramp(f, 0, 10) }}>{kicker}</div>}
      <div style={{ fontFamily: T.font, fontWeight: 800, fontSize: 84, letterSpacing: -2, lineHeight: 1, marginTop: 14, textTransform: "uppercase",
        opacity: ramp(f, 0, 12), translate: `0 ${(1 - ramp(f, 0, 16)) * 24}px` }}>{title}</div>

      {mode === "compare" && (
        <div style={{ marginTop: 50, display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 40, rowGap: 22 }}>
          <div style={{ fontFamily: T.monoFont, fontSize: 30, letterSpacing: 3, color: P.ink3, opacity: ramp(f, 6, 10) }}>{left}</div>
          <div style={{ fontFamily: T.monoFont, fontSize: 30, letterSpacing: 3, color: P.ink, opacity: ramp(f, 6, 10) }}>{right}</div>
          {rows.map((r, i) => {
            const a = at(i);
            const k = ramp(f, a, 12);
            const check = pop(f, fps, a + 10, 12);
            return (
              <React.Fragment key={r.left}>
                <div style={{ fontFamily: T.font, fontSize: 40, lineHeight: 1.2, color: P.ink3, padding: "18px 24px", border: `3px solid ${P.ink}33`, borderRadius: 12,
                  opacity: k, translate: `${(1 - OUT(k)) * -40}px 0`, textDecoration: f > a + 14 ? `line-through ${P.ink3}88` : "none" }}>{r.left}</div>
                <div style={{ position: "relative", fontFamily: T.font, fontWeight: 700, fontSize: 40, lineHeight: 1.2, padding: "18px 24px 18px 78px", background: "#fffcf5",
                  border: `4px solid ${P.ink}`, borderRadius: 12, boxShadow: `6px 6px 0 ${P.ink}`, opacity: ramp(f, a + 6, 12), translate: `${(1 - OUT(ramp(f, a + 6, 14))) * 40}px 0` }}>
                  <span style={{ position: "absolute", left: 22, top: "50%", translate: "0 -50%", width: 40, height: 40, borderRadius: 999, background: P.okBright,
                    border: `3px solid ${P.ink}`, display: "grid", placeItems: "center", fontSize: 26, scale: `${check}` }}>✓</span>
                  {r.right}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      )}

      {mode === "pillars" && (
        <div style={{ marginTop: 56, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 30 }}>
          {cards.map((c, i) => {
            const a = at(i);
            const k = pop(f, fps, a, 13);
            const lit = f >= a && (i === cards.length - 1 || f < at(i + 1));
            return (
              <div key={c.name} style={{ background: "#fffcf5", border: `5px solid ${P.ink}`, borderRadius: 16, padding: "28px 34px", minHeight: 230,
                boxShadow: `${lit ? 12 : 7}px ${lit ? 12 : 7}px 0 ${CARD_COLORS[i % 4]}`, opacity: Math.min(1, k * 1.3), scale: `${0.86 + 0.14 * k}`,
                rotate: `${(1 - k) * (i % 2 ? 3 : -3)}deg` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <span style={{ width: 30, height: 30, borderRadius: 6, background: CARD_COLORS[i % 4], border: `3px solid ${P.ink}` }} />
                  <span style={{ fontFamily: T.font, fontWeight: 800, fontSize: 52, letterSpacing: -1 }}>{c.name}</span>
                </div>
                <div style={{ marginTop: 16, fontFamily: T.font, fontSize: 36, lineHeight: 1.3, color: P.ink2 }}>{c.does}</div>
              </div>
            );
          })}
        </div>
      )}
    </AbsoluteFill>
  );
};
