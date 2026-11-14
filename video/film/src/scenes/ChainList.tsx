import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { OUT, ramp } from "../lib/anim";
import { P, T } from "../theme";

/** A test account's real rescues, as the vault returns them from get_rescues: a counter climbs to the total while
 *  the rows scroll past, each one a real transfer the vault made on NEAR testnet. */
export type ChainListProps = {
  user: string;
  vault: string;
  count: number;
  rows: { at: string; amount: string; quote: string; deposit: string }[];
  dur: number;
};

export const ChainList: React.FC<ChainListProps> = ({ user, vault, count, rows, dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const k = ramp(f, Math.round(0.3 * fps), Math.round(Math.min(3.2, dur / fps - 1) * fps));
  const shown = Math.round(OUT(k) * count);
  const ROW = 74;
  const scroll = Math.max(0, rows.length * ROW - 620) * Math.min(1, f / Math.max(1, dur - fps));
  return (
    <AbsoluteFill style={{ background: P.paper, padding: `${T.safeY}px ${T.safeX}px`, color: P.ink }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div style={{ fontFamily: T.monoFont, fontSize: 28, letterSpacing: 4, color: P.stampText }}>READ FROM {vault.toUpperCase()} · get_rescues</div>
          <div style={{ fontFamily: T.font, fontWeight: 800, fontSize: 76, letterSpacing: -2, marginTop: 10 }}>{user}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: T.monoFont, fontWeight: 300, fontSize: 150, lineHeight: 0.9, letterSpacing: -4 }}>{shown}</div>
          <div style={{ fontFamily: T.monoFont, fontSize: 28, letterSpacing: 3, color: P.ink3 }}>REAL RESCUES · NEAR TESTNET</div>
        </div>
      </div>
      <div style={{ marginTop: 34, height: 640, overflow: "hidden", border: `4px solid ${P.ink}`, borderRadius: 14, background: "#fffcf5" }}>
        <div style={{ translate: `0 ${-scroll}px` }}>
          {rows.map((r, i) => (
            <div key={i} style={{ height: ROW, display: "grid", gridTemplateColumns: "70px 330px 200px 1fr 150px", alignItems: "center", gap: 20, padding: "0 28px",
              borderBottom: `2px solid ${P.ink}14`, fontFamily: T.monoFont, fontSize: 26, opacity: ramp(f, Math.round(0.3 * fps) + i, 6) }}>
              <span style={{ color: P.ink3 }}>#{i + 1}</span>
              <span>{r.at}</span>
              <span style={{ fontWeight: 600 }}>{r.amount}</span>
              <span style={{ color: P.ink3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>→ {r.deposit}</span>
              <span style={{ justifySelf: "end", fontSize: 22, letterSpacing: 2, padding: "4px 12px", border: `3px solid ${P.ink}`, background: P.okBright }}>PAID</span>
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
