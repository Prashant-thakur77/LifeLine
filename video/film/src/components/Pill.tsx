import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { P, T } from "../theme";
import { envelope } from "../lib/anim";

/** The model pill: names the Claude model that is working at that moment and what it is doing. */
export const Pill: React.FC<{ model: string; job: string; at: number; dur: number; corner?: "tl" | "tr" }> = ({ model, job, at, dur, corner = "tr" }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = Math.round(at * fps), b = a + Math.round(dur * fps);
  if (f < a || f > b + 8) return null;
  const o = envelope(f, a, b);
  const dot = 0.5 + 0.5 * Math.sin(f / 4);
  return (
    <div style={{ position: "absolute", top: 46, [corner === "tr" ? "right" : "left"]: 60, opacity: o, display: "flex", alignItems: "center", gap: 14,
      background: "#121315ee", color: P.paper, padding: "12px 22px", fontFamily: T.monoFont, fontSize: 26, border: `1px solid ${P.paper}33`, zIndex: 5 }}>
      <span style={{ width: 14, height: 14, borderRadius: 7, background: P.stampOnInk, opacity: 0.4 + 0.6 * dot }} />
      <b style={{ fontWeight: 600 }}>{model}</b>
      <span style={{ color: `${P.paper}99` }}>· {job}</span>
    </div>
  );
};
