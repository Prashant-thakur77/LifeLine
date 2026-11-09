"use client";

import { useId, type ReactNode } from "react";

/*
 * Four small paper-cut scenes for "How a rescue happens". Flat sheets of colour with a
 * soft shadow under each, a little riso dot texture, and one quiet motion each. They
 * are diagrams of the mechanism, not data, so nothing in them claims a number.
 * Each motion runs on its own layer (see Sheet), so the scenes never repaint while they play.
 */

const INK = "#0b1533";
const PAPER = "#fffcf5";
const SEA = "#1d4bff";
const SEA_DEEP = "#0e2fb3";
const SEA_LIGHT = "#b7ccff";
const SEA_MID = "#6f93ff";
const SUN = "#ffc93c";
const RESCUE = "#ff5a1f";
const MINT = "#19c79a";

type Draw = (ids: { shadow: string; dots: string }) => ReactNode;
type Motion = "drop" | "beam" | "bob";

/**
 * One printed layer: the drawing, its second ink a hair out of register, and optionally
 * the paper grain. It never changes once drawn, so the browser paints it once.
 */
function Layer({ draw, grain = false }: { draw: Draw; grain?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const shadow = `ps-${id}`;
  const dots = `dots-${id}`;
  const tint = `tint-${id}`;
  const noise = `grain-${id}`;
  return (
    <svg viewBox="0 0 320 220" className="absolute inset-0 size-full" aria-hidden>
      <defs>
        <filter id={shadow} x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="3" stdDeviation="2.4" floodColor={INK} floodOpacity="0.22" />
        </filter>
        <filter id={tint}>
          <feFlood floodColor={RESCUE} result="ink" />
          <feComposite in="ink" in2="SourceAlpha" operator="in" />
        </filter>
        {grain ? (
          <filter id={noise} x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
            <feColorMatrix values="0 0 0 0 0.04  0 0 0 0 0.08  0 0 0 0 0.2  0 0 0 0.22 0" />
          </filter>
        ) : null}
        <pattern id={dots} width="7" height="7" patternUnits="userSpaceOnUse">
          <circle cx="3.5" cy="3.5" r="1.3" fill={INK} opacity="0.16" />
        </pattern>
      </defs>
      {/* Second ink, printed a hair out of register. */}
      <g transform="translate(2.6 1.8)" opacity="0.32" style={{ mixBlendMode: "multiply" }} filter={`url(#${tint})`}>
        {draw({ shadow: "none", dots: `url(#${dots})` })}
      </g>
      {draw({ shadow: `url(#${shadow})`, dots: `url(#${dots})` })}
      {grain ? <rect width="320" height="220" filter={`url(#${noise})`} opacity="0.5" style={{ mixBlendMode: "multiply" }} /> : null}
    </svg>
  );
}

const MOTION: Record<Motion, string> = { drop: "art-drop", beam: "art-beam", bob: "art-bob" };

/**
 * A scene is a stack of layers, back to front. The one part that moves sits on a layer
 * of its own, which the browser slides or turns without repainting anything, so the
 * scene costs nothing while it plays. The grain is printed on the front layer.
 */
function Sheet({ label, layers }: { label: string; layers: { draw: Draw; motion?: Motion }[] }) {
  return (
    <div role="img" aria-label={label} className="relative block aspect-[320/220] w-full overflow-hidden">
      {layers.map((layer, i) =>
        layer.motion ? (
          <div key={i} className={`absolute inset-0 will-change-transform ${MOTION[layer.motion]}`}>
            <Layer draw={layer.draw} />
          </div>
        ) : (
          <Layer key={i} draw={layer.draw} grain={i === layers.length - 1} />
        ),
      )}
    </div>
  );
}

/** Fund: tokens from other chains drop into the vault. */
export function FundScene() {
  return (
    <Sheet
      label="Tokens from other chains dropping into a vault"
      layers={[
        {
          draw: ({ shadow, dots }) => (
            <>
              <circle cx="250" cy="58" r="40" fill={SUN} />
              <circle cx="250" cy="58" r="40" fill={dots} />
              <g filter={shadow}>
                <rect x="96" y="96" width="128" height="104" rx="10" fill={SEA} />
                <rect x="96" y="96" width="128" height="104" rx="10" fill={dots} />
                <circle cx="160" cy="150" r="30" fill={SEA_DEEP} />
                {/* The vault door's wheel */}
                <circle cx="160" cy="150" r="17" fill="none" stroke={PAPER} strokeWidth="4.5" />
                <g stroke={PAPER} strokeWidth="4.5" strokeLinecap="round">
                  <line x1="160" y1="128" x2="160" y2="172" />
                  <line x1="141" y1="139" x2="179" y2="161" />
                  <line x1="141" y1="161" x2="179" y2="139" />
                </g>
                <circle cx="160" cy="150" r="6" fill={RESCUE} stroke={INK} strokeWidth="2" />
                <rect x="104" y="120" width="8" height="18" rx="2" fill={INK} />
                <rect x="104" y="160" width="8" height="18" rx="2" fill={INK} />
                <rect x="136" y="92" width="48" height="9" rx="4.5" fill={INK} />
              </g>
              <path d="M 44 34 Q 110 10 150 86" fill="none" stroke={INK} strokeWidth="1.6" strokeDasharray="3 5" opacity="0.5" />
              <path d="M 284 128 Q 230 70 172 86" fill="none" stroke={INK} strokeWidth="1.6" strokeDasharray="3 5" opacity="0.5" />
            </>
          ),
        },
        {
          motion: "drop",
          draw: ({ shadow }) => (
            <g filter={shadow}>
              <circle cx="160" cy="70" r="15" fill={RESCUE} stroke={INK} strokeWidth="2" />
              <text x="160" y="75" textAnchor="middle" fontSize="13" fontWeight="800" fill={INK}>
                $
              </text>
            </g>
          ),
        },
        {
          draw: ({ shadow }) => (
            <g filter={shadow}>
              <circle cx="44" cy="34" r="13" fill={MINT} stroke={INK} strokeWidth="2" />
              <circle cx="284" cy="128" r="13" fill={SUN} stroke={INK} strokeWidth="2" />
              <circle cx="62" cy="150" r="10" fill={SEA_LIGHT} stroke={INK} strokeWidth="2" />
            </g>
          ),
        },
      ]}
    />
  );
}

/** Policy: your lines, painted on the hull. */
export function PolicyScene() {
  return (
    <Sheet
      label="A load line painted on a hull: warn, rescue and refill levels"
      layers={[
        {
          draw: ({ shadow, dots }) => (
            <>
              <g filter={shadow}>
                <path d="M 40 30 H 280 V 220 H 40 Z" fill={RESCUE} />
                <rect x="40" y="44" width="240" height="7" fill={PAPER} />
                <rect x="40" y="56" width="240" height="2.5" fill={INK} />
              </g>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                <circle key={i} cx={58 + i * 24} cy="70" r="2.6" fill={INK} opacity="0.35" />
              ))}
              <rect x="196" y="86" width="3" height="134" fill={INK} />
              {[
                { y: 104, w: 46, fill: INK },
                { y: 138, w: 46, fill: SUN },
                { y: 164, w: 46, fill: INK, dashed: true },
              ].map((m) => (
                <rect key={m.y} className="art-paint" x="199" y={m.y - 3} width={m.w} height="6" fill={m.fill} strokeDasharray={m.dashed ? "4 3" : undefined} />
              ))}
              <g>
                <circle cx="122" cy="104" r="26" fill={PAPER} stroke={INK} strokeWidth="6" />
                <rect x="88" y="100" width="68" height="8" fill={INK} />
              </g>
              <path d="M 40 196 Q 80 186 120 196 T 200 196 T 280 196 V 220 H 40 Z" fill={SEA} />
              <path d="M 40 196 Q 80 186 120 196 T 200 196 T 280 196 V 220 H 40 Z" fill={dots} />
            </>
          ),
        },
      ]}
    />
  );
}

/** Watch: a lighthouse whose beam sweeps once every 5 seconds, the keeper's own pace. */
export function WatchScene() {
  return (
    <Sheet
      label="A lighthouse sweeping its beam over the sea every five seconds"
      layers={[
        {
          motion: "beam",
          draw: () => <path d="M 176 70 L 320 34 L 320 112 Z" fill={SUN} opacity="0.75" />,
        },
        {
          draw: ({ shadow, dots }) => (
            <>
              <path d="M 0 174 Q 40 162 80 174 T 160 174 T 240 174 T 320 174 V 220 H 0 Z" fill={SEA_MID} />
              <g filter={shadow}>
                <path d="M 112 220 L 132 168 H 224 L 244 220 Z" fill={INK} />
                <path d="M 158 168 L 164 80 H 188 L 194 168 Z" fill={PAPER} />
                <path d="M 160.5 136 H 191.5 L 192.6 152 H 159.4 Z" fill={RESCUE} />
                <path d="M 162.6 104 H 189.4 L 190.4 118 H 161.6 Z" fill={RESCUE} />
                <rect x="160" y="62" width="32" height="20" rx="3" fill={SUN} stroke={INK} strokeWidth="2.5" />
                <path d="M 156 62 L 176 44 L 196 62 Z" fill={INK} />
              </g>
              <path d="M 0 192 Q 50 180 100 192 T 200 192 T 320 192 V 220 H 0 Z" fill={SEA} />
              <path d="M 0 192 Q 50 180 100 192 T 200 192 T 320 192 V 220 H 0 Z" fill={dots} />
            </>
          ),
        },
      ]}
    />
  );
}

/** Rescue: a line thrown, a lifebuoy on the water. */
export function RescueScene() {
  return (
    <Sheet
      label="A lifebuoy on a line, landing on the water"
      layers={[
        {
          draw: () => (
            <>
              <path d="M 300 0 Q 230 20 168 120" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />
              <path d="M 300 0 Q 230 20 168 120" fill="none" stroke={RESCUE} strokeWidth="2" strokeDasharray="3 6" strokeLinecap="round" />
              <path d="M 0 132 Q 40 120 80 132 T 160 132 T 240 132 T 320 132 V 220 H 0 Z" fill={SEA_LIGHT} />
            </>
          ),
        },
        {
          motion: "bob",
          draw: ({ shadow }) => (
            <g filter={shadow}>
              <circle cx="168" cy="132" r="30" fill="none" stroke={PAPER} strokeWidth="16" />
              <circle
                cx="168"
                cy="132"
                r="30"
                fill="none"
                stroke={RESCUE}
                strokeWidth="16"
                strokeDasharray={`${(2 * Math.PI * 30) / 8} ${(2 * Math.PI * 30) / 8}`}
                transform="rotate(-22.5 168 132)"
              />
              <circle cx="168" cy="132" r="38.5" fill="none" stroke={INK} strokeWidth="2.2" />
              <circle cx="168" cy="132" r="21.5" fill="none" stroke={INK} strokeWidth="2.2" />
            </g>
          ),
        },
        {
          draw: ({ dots }) => (
            <>
              <path d="M 0 150 Q 50 138 100 150 T 200 150 T 320 150 V 220 H 0 Z" fill={SEA} />
              <path d="M 0 176 Q 40 166 80 176 T 160 176 T 240 176 T 320 176 V 220 H 0 Z" fill={SEA_DEEP} />
              <path d="M 0 176 Q 40 166 80 176 T 160 176 T 240 176 T 320 176 V 220 H 0 Z" fill={dots} />
            </>
          ),
        },
      ]}
    />
  );
}
