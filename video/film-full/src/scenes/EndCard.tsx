import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Sheets } from "../components/WaterLine";
import { ramp } from "../lib/anim";
import { P, T } from "../theme";

export const EndCard: React.FC<{ name: string; tagline: string; links: string[]; logo?: string; dur: number }> = ({ tagline, links }) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: P.paper, color: P.ink, justifyContent: "center", alignItems: "center" }}>
      <Sheets level={1080 - 120 + 40 * (1 - ramp(f, 0, 30))} f={f} W={1920} H={1080} />
      <div style={{ fontFamily: T.font, fontWeight: 800, fontSize: 230, letterSpacing: -6, lineHeight: 0.9, opacity: ramp(f, 0, 12), translate: `0 ${(1 - ramp(f, 0, 16)) * 30}px` }}>
        LIFE<span style={{ color: P.stamp }}>LINE</span>
      </div>
      <div style={{ marginTop: 26, fontFamily: T.font, fontWeight: 500, fontSize: 48, opacity: ramp(f, 12, 12) }}>{tagline}</div>
      <div style={{ marginTop: 44, display: "flex", gap: 40, fontFamily: T.monoFont, fontSize: 32, opacity: ramp(f, 22, 12), marginBottom: 120 }}>
        {links.map((l) => <span key={l}>{l}</span>)}
      </div>
    </AbsoluteFill>
  );
};
