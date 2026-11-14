import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { P, T } from "../theme";

/** Two grounds from the film's world. "night": the record room after hours, a warm lamp pool drifting over carbon
 *  black. "paper": court paper with fibre grain and faint ruled lines. Both always move a little. */
export const Backdrop: React.FC<{ dim?: number; ground?: "night" | "paper" }> = ({ dim = 0, ground = "night" }) => {
  const f = useCurrentFrame();
  const a = f / 260;
  const x = 38 + Math.sin(a) * 10, y = 34 + Math.cos(a * 0.8) * 8;
  const paper = ground === "paper";
  return (
    <AbsoluteFill style={{ backgroundColor: paper ? P.paper : T.bg }}>
      {paper ? (
        <AbsoluteFill style={{
          backgroundImage: `repeating-linear-gradient(180deg, transparent 0 47px, ${P.carbonSoft}22 47px 48px)`,
          backgroundPosition: `0 ${(f * 0.25) % 48}px`, maskImage: "linear-gradient(90deg, transparent, black 12%, black 88%, transparent)",
        }} />
      ) : (
        <>
          <AbsoluteFill style={{ background: `radial-gradient(55% 60% at ${x}% ${y}%, #ffcf8a1f, transparent 70%)` }} />
          <AbsoluteFill style={{ background: `radial-gradient(45% 45% at ${100 - x}% ${100 - y}%, ${P.carbon}55, transparent 70%)` }} />
        </>
      )}
      <AbsoluteFill style={{ opacity: paper ? 0.16 : 0.07, mixBlendMode: paper ? "multiply" : "overlay" }}>
        <svg width="100%" height="100%">
          <filter id={`g-${ground}`}>
            <feTurbulence type="fractalNoise" baseFrequency={paper ? "0.65" : "0.9"} numOctaves="3" seed={f % 12} />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter={`url(#g-${ground})`} />
        </svg>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "radial-gradient(130% 100% at 50% 45%, transparent 60%, rgba(0,0,0,.28))" }} />
      {dim > 0 && <AbsoluteFill style={{ backgroundColor: `rgba(0,0,0,${dim})` }} />}
    </AbsoluteFill>
  );
};
