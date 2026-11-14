import React from "react";
import { staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import { pop, ramp } from "../lib/anim";
import { T } from "../theme";

/** The founder speaking over a scene: a round picture-in-picture of the on-camera recording, in sync with the voice.
 *  `from` is the recording's second at this scene's first frame (the voice take is cut from the same recording). */
export type FacePipProps = { src: string; from: number; name?: string; size?: number; corner?: "br" | "tr" };

export const FacePip: React.FC<FacePipProps & { dur: number }> = ({ src, from, name, size = 260, corner = "br", dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const k = pop(f, fps, Math.round(fps * 0.15), 14);
  const out = 1 - ramp(f, dur - Math.round(fps * 0.35), Math.round(fps * 0.3));
  const pos = corner === "br" ? { right: 80, bottom: 120 } : { right: 80, top: 70 };
  return (
    <div style={{ position: "absolute", ...pos, width: size, opacity: Math.min(1, k * 1.4) * out, scale: `${0.8 + 0.2 * k}`, transformOrigin: "100% 100%" }}>
      <div style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden", border: `6px solid ${T.fg}`,
        boxShadow: `0 0 0 4px ${T.accent}, 0 18px 50px rgba(0,0,0,.55)`, background: "#000" }}>
        <Video src={staticFile(src)} trimBefore={Math.round(from * fps)} muted objectFit="cover"
          style={{ width: "100%", height: "100%", objectPosition: "50% 22%", scale: "1.35" }} />
      </div>
      {name && (
        <div style={{ position: "absolute", left: "50%", bottom: -20, translate: "-50% 0", whiteSpace: "nowrap", padding: "6px 16px", borderRadius: 999,
          background: T.accent, color: "#fff", fontFamily: T.font, fontWeight: 700, fontSize: 24 }}>{name}</div>
      )}
    </div>
  );
};
