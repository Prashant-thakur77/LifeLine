import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { OUT, pop, ramp } from "../lib/anim";
import { P, T } from "../theme";

/** The team's real X account: screenshots of the profile and its posts, each shown in turn as a card that drifts
 *  in and settles, the previous one stepping back behind it. */
export type XPostsProps = { images: { src: string; aspect: number }[]; handle: string; dur: number };

export const XPosts: React.FC<XPostsProps> = ({ images, handle, dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const n = Math.max(1, images.length);
  const slot = (dur - fps * 0.8) / n;
  return (
    <AbsoluteFill style={{ background: `radial-gradient(120% 90% at 30% 20%, #16245e, ${P.night})`, alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", left: T.safeX, top: 70, fontFamily: T.monoFont, fontSize: 28, letterSpacing: 4, color: P.paper, opacity: ramp(f, 0, 12) }}>
        ON X · <span style={{ color: P.stamp }}>{handle}</span>
      </div>
      {images.map((im, i) => {
        const a = Math.round(i * slot);
        if (f < a - 2) return null;
        const k = pop(f, fps, a, 16);
        const next = i < n - 1 ? ramp(f, Math.round((i + 1) * slot), 14) : 0;
        const local = Math.min(1, Math.max(0, (f - a) / (slot + fps)));
        return (
          <div key={im.src} style={{ position: "absolute", width: Math.min(1320, 780 * im.aspect), height: Math.min(1320, 780 * im.aspect) / im.aspect, borderRadius: 26, overflow: "hidden", background: "#000",
            border: `3px solid ${P.paper}`, boxShadow: "0 30px 80px rgba(0,0,0,.55)",
            opacity: Math.min(1, k * 1.3) * (1 - 0.65 * next),
            translate: `${(1 - OUT(Math.min(1, k))) * 120 - next * 60}px ${30 + next * -40}px`,
            scale: `${(0.92 + 0.08 * k) * (1 - 0.08 * next)}`, filter: `blur(${next * 4}px)` }}>
            <Img src={staticFile(im.src)} style={{ width: "100%", height: "100%", scale: `${1 + 0.04 * local}` }} />
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
