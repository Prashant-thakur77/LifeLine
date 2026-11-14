import React from "react";
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import { P, T } from "../theme";
import { OUT, ramp } from "../lib/anim";

/** The recap: fast cuts of the real product (each clip from a capture, ~1-2 s) under one kinetic line each.
 *  Lines are only claims the film has already proven. */
export const Montage: React.FC<{ items: { src: string; from: number; line: string; at: number; zoom?: [number, number] }[]; dur: number }> = ({ items, dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: P.ink }}>
      {items.map((it, i) => {
        const a = Math.round(it.at * fps);
        const b = i + 1 < items.length ? Math.round(items[i + 1].at * fps) : dur;
        const local = f - a;
        const z = it.zoom ?? [0.5, 0.45];
        return (
          <Sequence key={i} from={a} durationInFrames={b - a} layout="none">
            <AbsoluteFill style={{ scale: `${1.25 + 0.06 * (local / Math.max(1, b - a))}`, transformOrigin: `${z[0] * 100}% ${z[1] * 100}%`, filter: "brightness(.55) saturate(.9)" }}>
              <Video src={staticFile(it.src)} trimBefore={Math.round(it.from * fps)} muted style={{ width: "100%", height: "100%" }} />
            </AbsoluteFill>
            <AbsoluteFill style={{ background: "linear-gradient(90deg, rgba(18,19,21,.92) 0%, rgba(18,19,21,.6) 55%, rgba(18,19,21,.1))" }} />
            <div style={{ position: "absolute", left: T.safeX, top: 430, width: 1300, fontFamily: T.font, fontWeight: 800, fontSize: 92,
              letterSpacing: -2, lineHeight: 1.02, color: i === items.length - 1 ? P.stampOnInk : P.paper,
              clipPath: `inset(0 ${(1 - ramp(local, 0, 10, OUT)) * 100}% 0 0)` }}>{it.line}</div>
            <div style={{ position: "absolute", left: T.safeX, top: 400, width: 120 * ramp(local, 2, 10), height: 6, background: P.stampOnInk }} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
