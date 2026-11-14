import React from "react";
import { AbsoluteFill } from "remotion";
import { Sheets } from "./components/WaterLine";
import { P, T } from "./theme";

/** YouTube/X thumbnail: the name, the promise and the sea. */
export const Thumbnail: React.FC = () => (
  <AbsoluteFill style={{ background: P.paper, padding: 60 }}>
    <Sheets level={560} f={0} W={1280} H={720} />
    <div style={{ fontFamily: T.monoFont, fontSize: 28, letterSpacing: 6, color: P.ink2 }}>HYPERLIQUID · NEAR INTENTS</div>
    <div style={{ fontFamily: T.font, fontWeight: 800, fontSize: 128, lineHeight: 0.9, letterSpacing: -5, color: P.ink, marginTop: 30 }}>
      TOPPED UP<br />BEFORE<br /><span style={{ color: P.stamp }}>LIQUIDATION.</span>
    </div>
  </AbsoluteFill>
);
