import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { OUT, pop, ramp } from "../lib/anim";
import { P, T } from "../theme";

/** The moment to remember: every trick a hacked keeper can try runs into the vault, and each comes back stamped
 *  with the vault's own answer, word for word from the live attack lab on NEAR testnet. */
export const TrickWall: React.FC<{ items: { title: string; answer: string }[]; start?: number; each?: number; dur: number }> = ({ items, start = 0.3, each = 0.55 }) => {
  const f = useCurrentFrame();
  const { fps, width: W } = useVideoConfig();
  const vaultX = W - 420;
  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${P.night}, #101c4a)` }}>
      <div style={{ position: "absolute", left: T.safeX, top: T.safeY - 10, fontFamily: T.monoFont, fontSize: 28, letterSpacing: 5, color: P.mark, opacity: ramp(f, 0, 10) }}>
        A HACKED KEEPER · ITS REAL KEY · NEAR TESTNET
      </div>
      {/* The vault: a printed safe door. */}
      <div style={{ position: "absolute", left: vaultX, top: 140, width: 330, height: 750, background: P.paper, border: `8px solid ${P.ink}`, borderRadius: 18,
        boxShadow: `14px 14px 0 ${P.stamp}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 26 }}>
        <div style={{ width: 190, height: 190, borderRadius: 999, border: `14px solid ${P.ink}`, rotate: `${f * 1.2}deg`,
          background: `conic-gradient(${P.stamp} 0 12%, transparent 12% 25%, ${P.stamp} 25% 37%, transparent 37% 50%, ${P.stamp} 50% 62%, transparent 62% 75%, ${P.stamp} 75% 87%, transparent 87%)` }} />
        <div style={{ fontFamily: T.font, fontWeight: 800, fontSize: 64, color: P.ink, letterSpacing: -1 }}>VAULT</div>
        <div style={{ fontFamily: T.monoFont, fontSize: 22, color: P.ink3, textAlign: "center" }}>vault.lifeline-team<br />.testnet</div>
      </div>
      <div style={{ position: "absolute", left: T.safeX, top: 140, width: vaultX - T.safeX - 60, display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map((it, i) => {
          const at = Math.round((start + i * each) * fps);
          const fly = ramp(f, at, 9);
          const hit = f >= at + 9;
          const stamp = pop(f, fps, at + 9, 11);
          const shake = hit && f < at + 15 ? Math.sin((f - at) * 2.4) * 6 : 0;
          return (
            <div key={it.title} style={{ position: "relative", height: 96, opacity: fly, translate: `${(1 - OUT(fly)) * -260 + shake}px 0`,
              background: P.paper, border: `4px solid ${P.ink}`, borderRadius: 10, padding: "12px 22px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div style={{ fontFamily: T.font, fontWeight: 750, fontSize: 36, color: P.ink }}>{it.title}</div>
              <div style={{ fontFamily: T.monoFont, fontSize: 23, color: P.stampText, opacity: ramp(f, at + 10, 8), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 900 }}>
                {it.answer}
              </div>
              {hit && (
                <div style={{ position: "absolute", right: 22, top: 22, fontFamily: T.monoFont, fontWeight: 600, fontSize: 30, letterSpacing: 5, color: P.danger,
                  border: `5px solid ${P.danger}`, padding: "4px 14px", rotate: "-8deg", scale: `${1.6 - 0.6 * stamp}`, opacity: Math.min(1, stamp * 1.4), background: "#fff7eadd" }}>
                  REFUSED
                </div>
              )}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
