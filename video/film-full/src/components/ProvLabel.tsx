import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { P, T } from "../theme";
import { envelope } from "../lib/anim";

/** Provenance label, bottom-left: what this footage is ("live site", "recorded session · sped up 4×", "planted quote"). */
export const ProvLabel: React.FC<{ text: string; at?: number; dur?: number; dur_?: number } & { dur: number }> = ({ text, at = 0.3 }) => {
  const f = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const a = Math.round(at * fps);
  const o = envelope(f, a, durationInFrames);
  return (
    <div style={{ position: "absolute", left: 60, top: 50, opacity: o, fontFamily: T.monoFont, fontSize: 24, letterSpacing: 1,
      color: P.paper, background: "#121315dd", padding: "8px 16px", border: `1px solid ${P.paper}33`, zIndex: 6 }}>{text}</div>
  );
};
