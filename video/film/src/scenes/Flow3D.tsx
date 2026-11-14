import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { P, T } from "../theme";
import { INOUT, OUT, envelope, pop, ramp, rand } from "../lib/anim";

/** "Under the hood" as one rescue, told as a journey across a small 3D world:
 *  Hyperliquid's platform with the trader's health gauge falling toward liquidation → the keeper drone, whose only
 *  key fits the vault's "rescue" lock → the vault on NEAR checks 1Click's signed quote (a seal stamps the door) and
 *  opens → a USDC capsule flies the NEAR Intents arc into Hyperliquid and the gauge climbs back → a hacked drone tries
 *  the same lock with its own address and the door stays shut (BAD_QUOTE) → NEAR AI Cloud's satellite explains it.
 *  Every value is a function of the frame (no useFrame), so renders are reproducible. */
export type Flow3DProps = {
  title?: string;
  /** Seconds from the scene's start for each beat. Missing beats fall back to a spread over the scene. */
  cues?: Partial<Record<"hl" | "keeper" | "vault" | "intents" | "landed" | "attack" | "ai", number>>;
  amount?: string;   // what the capsule carries, e.g. "+3.47 USDC"
  from?: number;     // health before (falls toward the trigger)
  to?: number;       // health after the rescue
  dur: number;       // frames
};

const VAULT = new THREE.Vector3(-4.3, 0, 0);
const HL = new THREE.Vector3(4.3, -0.55, 0);
const LOCK = new THREE.Vector3(VAULT.x, 1.12, 0.1);
const GAUGE = new THREE.Vector3(HL.x + 0.95, HL.y + 0.2, 0.35);
const G_H = 2.6;            // gauge height in world units
const G_MIN = 1.0, G_MAX = 2.4;
const ARC = new THREE.QuadraticBezierCurve3(new THREE.Vector3(VAULT.x + 0.2, 0.15, 1.05), new THREE.Vector3(0, 4.6, 1.6),
  new THREE.Vector3(HL.x + 0.95, HL.y + 0.45, 0.35));
const GOLD = "#ffc93c", NEAR_GREEN = "#19c79a", SEA = "#1d4bff";

const camAt = (f: number, dur: number) => {
  const t = Math.min(1, f / Math.max(1, dur));
  const e = INOUT(t);
  const ang = THREE.MathUtils.degToRad(-12 + 16 * e);  // slow orbit, left to right
  const r = 15.6 - 1.4 * OUT(t);                        // gentle dolly in
  return { pos: new THREE.Vector3(Math.sin(ang) * r, 4.3 - 0.8 * e, Math.cos(ang) * r), look: new THREE.Vector3(0.45, 0.8, 0) };
};

const beats = (cues: Flow3DProps["cues"], durS: number) => {
  const d = (k: number) => Math.min(durS - 0.5, durS * k);
  return {
    hl: cues?.hl ?? d(0.02), keeper: cues?.keeper ?? d(0.17), vault: cues?.vault ?? d(0.31), intents: cues?.intents ?? d(0.45),
    landed: cues?.landed ?? d(0.59), attack: cues?.attack ?? d(0.69), ai: cues?.ai ?? d(0.85),
  };
};

/** Where the two keepers are at frame f (shared by the 3D world and the 2D labels). */
const actors = (f: number, fps: number, b: ReturnType<typeof beats>) => {
  const F = (s: number) => Math.round(s * fps);
  const kIn = ramp(f, F(b.keeper) - 10, F(b.vault - b.keeper) - 4, INOUT);
  const dStart = new THREE.Vector3(0.6, 3.4, 2.2), dLock = LOCK.clone().add(new THREE.Vector3(0, 0.95, 0));
  const drone = dStart.clone().lerp(dLock, kIn).add(new THREE.Vector3(0, Math.sin(f / 9) * 0.06 + (1 - kIn) * Math.sin(kIn * Math.PI) * 0.6, 0));
  const lift = ramp(f, F(b.intents), F(1.4), INOUT);
  drone.add(new THREE.Vector3(2.6 * lift, 0.9 * lift, -3.2 * lift));
  const aIn = ramp(f, F(b.attack), F(1.0), INOUT);
  const aOut = ramp(f, F(b.attack) + F(1.7), F(1.0), INOUT);
  const attacker = new THREE.Vector3(-8.5, 2.6, 3.0).lerp(LOCK.clone().add(new THREE.Vector3(0.1, 0.95, 0.1)), aIn).lerp(new THREE.Vector3(-8.5, 3.4, 2.4), aOut);
  return { kIn, lift, drone, aIn, aOut, attacker };
};

const health = (f: number, fps: number, b: ReturnType<typeof beats>, from: number, to: number) => {
  const fall = ramp(f, b.hl * fps, (b.keeper - b.hl) * fps + fps * 0.6, INOUT);
  const rise = ramp(f, b.landed * fps - fps * 0.1, fps * 1.4);
  const trig = 1.46;
  return from + (trig - from) * fall + (to - trig) * rise;
};

export const Flow3D: React.FC<Flow3DProps> = (p) => {
  const f = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const b = beats(p.cues, p.dur / fps);
  const F = (s: number) => Math.round(s * fps);
  const cam = useMemo(() => new THREE.PerspectiveCamera(30, W / H, 0.1, 200), [W, H]);
  const c = camAt(f, p.dur);
  cam.position.copy(c.pos); cam.lookAt(c.look); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const proj = (v: THREE.Vector3) => { const q = v.clone().project(cam); return [(q.x + 1) / 2 * W, (1 - q.y) / 2 * H] as const; };
  const h = health(f, fps, b, p.from ?? 1.62, p.to ?? 2.01);
  const hColor = h < 1.5 ? P.danger : h < 1.8 ? P.mark : P.okBright;
  const chip = (key: string, at: THREE.Vector3, start: number, end: number, dx: number, dy: number, dot: string, title: string, sub?: string, tone: "dark" | "bad" | "good" = "dark") => {
    if (f < start) return null;
    const [ax, ay] = proj(at);
    const x = ax + dx, y = ay + dy;
    const o = envelope(f, start, end, 10, 10);
    const k = OUT(ramp(f, start, 14));
    const bg = tone === "bad" ? P.danger : tone === "good" ? P.okBright : "rgba(10,18,48,.86)";
    const fg = tone === "dark" ? P.paper : P.ink;
    return (
      <React.Fragment key={key}>
        <svg width={W} height={H} style={{ position: "absolute", inset: 0, opacity: o }}>
          <circle cx={ax} cy={ay} r={7} fill={dot} stroke={P.paper} strokeWidth={2.5} />
          <path d={`M${ax},${ay} L${ax + (x - ax) * k},${ay + (y - ay) * k}`} stroke={`${P.paper}aa`} strokeWidth={2} fill="none" />
        </svg>
        <div style={{ position: "absolute", left: x, top: y, translate: `${dx < 0 ? "-100%" : "0"} -50%`, opacity: o * k, scale: `${0.94 + 0.06 * k}`,
          transformOrigin: dx < 0 ? "100% 50%" : "0% 50%", background: bg, color: fg, border: `2px solid ${tone === "dark" ? `${P.paper}33` : P.paper}`,
          borderRadius: 14, padding: "12px 20px 13px", boxShadow: "0 18px 40px rgba(0,0,0,.35)", whiteSpace: "nowrap", backdropFilter: "blur(6px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: T.font, fontWeight: 750, fontSize: 32, lineHeight: 1.1 }}>
            {tone === "dark" && <span style={{ width: 14, height: 14, borderRadius: 3, background: dot }} />}{title}
          </div>
          {sub && <div style={{ fontFamily: T.monoFont, fontSize: 21, marginTop: 6, opacity: tone === "dark" ? 0.82 : 0.9, marginLeft: tone === "dark" ? 26 : 0 }}>{sub}</div>}
        </div>
      </React.Fragment>
    );
  };
  const gTop = GAUGE.clone().add(new THREE.Vector3(0, ((Math.min(G_MAX, h) - G_MIN) / (G_MAX - G_MIN)) * G_H, 0));
  const end = p.dur + 30;
  const act = actors(f, fps, b);
  return (
    <AbsoluteFill>
      <ThreeCanvas width={W} height={H} camera={{ fov: 30, position: [c.pos.x, c.pos.y, c.pos.z], near: 0.1, far: 200 }}>
        <World {...p} b={b} h={h} hColor={hColor} />
      </ThreeCanvas>
      <div style={{ position: "absolute", left: T.safeX, top: 64, opacity: ramp(f, 0, 12) }}>
        <div style={{ fontFamily: T.monoFont, fontSize: T.label, letterSpacing: 4, textTransform: "uppercase", color: T.accent }}>{p.title ?? "Under the hood"}</div>
        <div style={{ fontFamily: T.font, fontWeight: 750, fontSize: 44, color: P.paper, marginTop: 6 }}>One rescue, end to end</div>
      </div>
      {/* health readout follows the gauge's top */}
      {f >= F(b.hl) && (() => {
        const [gx, gy] = proj(gTop.clone().add(new THREE.Vector3(0.35, 0, 0)));
        return (
          <div style={{ position: "absolute", left: gx + 18, top: gy, translate: "0 -50%", opacity: ramp(f, F(b.hl), 12), fontFamily: T.monoFont, color: P.paper }}>
            <div style={{ fontSize: 20, letterSpacing: 3, opacity: 0.8 }}>HEALTH</div>
            <div style={{ fontSize: 58, fontWeight: 600, color: hColor, lineHeight: 1 }}>{h.toFixed(2)}</div>
          </div>
        );
      })()}
      {(() => {
        const [lx, ly] = proj(GAUGE.clone().add(new THREE.Vector3(0, -0.2, 0.4)));
        return <div style={{ position: "absolute", left: lx, top: ly + 34, translate: "-50% 0", fontFamily: T.monoFont, fontSize: 20, color: P.paper, background: P.danger,
          padding: "4px 10px", borderRadius: 6, whiteSpace: "nowrap", letterSpacing: 2, opacity: ramp(f, F(b.hl) + 8, 12) }}>1.00 = LIQUIDATED</div>;
      })()}
      {chip("hl", new THREE.Vector3(HL.x - 0.9, HL.y + 0.25, 1.1), F(b.hl) + 6, F(b.keeper) + 10, -60, 150, SEA, "Hyperliquid", "your cross margin, read every 5 s")}
      {chip("keeper", act.drone.clone().add(new THREE.Vector3(0.3, 0.1, 0)), F(b.keeper) + 4, F(b.vault) + 8, 120, -60, GOLD, "Keeper",
        "16-rule policy engine · its only key calls rescue")}
      {chip("vault", new THREE.Vector3(VAULT.x + 0.9, -0.6, 0.9), F(b.vault), F(b.intents) + 10, 60, 90, P.stamp, "Vault on NEAR",
        "Rust · verifies 1Click's ed25519 signature on chain")}
      {chip("intents", ARC.getPoint(0.5), F(b.intents) + 4, F(b.landed) - 2, 0, -95, NEAR_GREEN, "NEAR Intents", "1Click swaps and delivers the USDC")}
      {chip("landed", gTop.clone().add(new THREE.Vector3(-0.4, 0.2, 0)), F(b.landed) + 8, F(b.attack) + 6, -120, -40, P.okBright,
        `${p.amount ?? "+3.47 USDC"} · margin topped up`, undefined, "good")}
      {chip("attack", new THREE.Vector3(VAULT.x + 0.9, 0.2, 0.9), F(b.attack) + Math.round(fps * 1.1), F(b.ai) + 4, 110, 60, P.danger,
        "BAD_QUOTE · refused on chain", "a hacked keeper pointed the money at itself", "bad")}
      {chip("ai", new THREE.Vector3(0.2, 3.35, -1.2), F(b.ai) + 6, end, 70, -40, "#8fb0ff", "NEAR AI Cloud", "explains each rescue · signed in a TEE")}
      {/* the seal: 1Click's signature, stamped on the vault door */}
      {f >= F(b.vault) && f < F(b.intents) + 20 && (() => {
        const [sx, sy] = proj(new THREE.Vector3(VAULT.x + 0.15, 0.2, 0.95));
        const k = pop(f, fps, F(b.vault), 11);
        return <div style={{ position: "absolute", left: sx, top: sy, translate: "-50% -50%", scale: `${2.2 - 1.2 * Math.min(1, k)}`, opacity: Math.min(1, k * 1.5) * envelope(f, F(b.vault), F(b.intents) + 20),
          width: 116, height: 116, borderRadius: "50%", border: `5px solid ${P.okBright}`, background: "rgba(25,199,154,.18)", color: P.okBright,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: T.monoFont, fontWeight: 600, fontSize: 18,
          rotate: "-12deg", textAlign: "center", lineHeight: 1.15 }}>
          <span style={{ fontSize: 40 }}>✓</span>SIGNED<br />QUOTE</div>;
      })()}
    </AbsoluteFill>
  );
};

type WorldProps = Flow3DProps & { b: ReturnType<typeof beats>; h: number; hColor: string };

/** A small flying keeper: body, visor, four spinning rotors, and a key hanging below. */
const Drone: React.FC<{ pos: THREE.Vector3; f: number; color: string; keyColor: string; tilt?: number; opacity?: number }> = ({ pos, f, color, keyColor, tilt = 0, opacity = 1 }) => (
  <group position={pos} rotation={[0, 0, tilt]}>
    <mesh><sphereGeometry args={[0.32, 32, 24]} /><meshPhysicalMaterial color={color} roughness={0.3} clearcoat={1} transparent opacity={opacity} /></mesh>
    <mesh position={[0, 0.05, 0.27]} scale={[1, 0.55, 0.4]}><sphereGeometry args={[0.18, 24, 16]} /><meshStandardMaterial color="#0b1533" emissive={keyColor} emissiveIntensity={0.9} transparent opacity={opacity} /></mesh>
    {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z], i) => (
      <group key={i} position={[x * 0.42, 0.18, z * 0.3]}>
        <mesh rotation={[0, 0, x * 0.5]} position={[-x * 0.2, -0.06, 0]}><boxGeometry args={[0.36, 0.05, 0.06]} /><meshStandardMaterial color={color} transparent opacity={opacity} /></mesh>
        <mesh rotation={[0, f * 0.9 + i, 0]}><boxGeometry args={[0.42, 0.012, 0.06]} /><meshStandardMaterial color={P.paper} transparent opacity={0.75 * opacity} /></mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[0.22, 24]} /><meshBasicMaterial color={P.paper} transparent opacity={0.08 * opacity} side={THREE.DoubleSide} /></mesh>
      </group>
    ))}
    <group position={[0, -0.5, 0]}>
      <mesh position={[0, 0.12, 0]}><cylinderGeometry args={[0.012, 0.012, 0.24, 8]} /><meshStandardMaterial color={P.paper} transparent opacity={opacity} /></mesh>
      <mesh position={[0, -0.05, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.1, 0.03, 12, 24]} /><meshStandardMaterial color={keyColor} metalness={0.7} roughness={0.25} emissive={keyColor} emissiveIntensity={0.35} transparent opacity={opacity} /></mesh>
      <mesh position={[0, -0.28, 0]}><boxGeometry args={[0.05, 0.3, 0.05]} /><meshStandardMaterial color={keyColor} metalness={0.7} roughness={0.25} transparent opacity={opacity} /></mesh>
      <mesh position={[0.05, -0.38, 0]}><boxGeometry args={[0.07, 0.04, 0.05]} /><meshStandardMaterial color={keyColor} metalness={0.7} roughness={0.25} transparent opacity={opacity} /></mesh>
    </group>
  </group>
);

const World: React.FC<WorldProps> = (p) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { camera } = useThree();
  const c = camAt(f, p.dur);
  camera.position.copy(c.pos); camera.lookAt(c.look); camera.updateMatrixWorld();
  const b = p.b;
  const F = (s: number) => Math.round(s * fps);

  // the arc, drawn on as the money moves
  const tube = useMemo(() => new THREE.TubeGeometry(ARC, 160, 0.045, 12, false), []);
  const glowTube = useMemo(() => new THREE.TubeGeometry(ARC, 160, 0.14, 12, false), []);
  const draw = ramp(f, F(b.intents) - 6, Math.round(fps * 0.9));
  const idx = tube.index!.count, gidx = glowTube.index!.count;
  tube.setDrawRange(0, Math.floor((idx / 6) * draw) * 6);
  glowTube.setDrawRange(0, Math.floor((gidx / 6) * draw) * 6);

  // keeper drone: flies in, lowers its key into the lock, then lifts away a little
  const { kIn, lift, drone: dronePos, aIn, attacker: aPos } = actors(f, fps, b);
  const lockLit = ramp(f, F(b.vault) - 6, 8) * (1 - ramp(f, F(b.landed), 12));

  // the vault door: opens once the quote checks out, closes after the money leaves
  const open = ramp(f, F(b.vault) + 14, F(0.9), INOUT) * (1 - ramp(f, F(b.landed) + 4, F(0.7), INOUT));

  // the capsule rides the arc from intents to landed
  const ride = ramp(f, F(b.intents) + 6, F(b.landed - b.intents) - 6, INOUT);
  const capsuleOn = f >= F(b.intents) + 2 && f < F(b.landed) + 6;
  const cp = ARC.getPoint(Math.min(1, ride));
  const tan = ARC.getTangent(Math.min(1, ride));
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan);
  const splash = ramp(f, F(b.landed), F(0.8));

  // hacked drone: approaches from the front right, tries the lock, gets bounced
  const shake = f > F(b.attack) + F(1.0) && f < F(b.attack) + F(1.6) ? Math.sin(f * 2.4) * 0.05 : 0;
  const refused = Math.max(0, 1 - Math.abs(f - (F(b.attack) + F(1.05))) / (fps * 0.55));
  const attackOn = f >= F(b.attack) && f < F(b.attack) + F(2.9);

  // NEAR AI satellite
  const aiK = ramp(f, F(b.ai), F(0.8));
  const sat = new THREE.Vector3(0.2 + Math.sin(f / 40) * 0.3, 3.35 + (1 - aiK) * 1.4, -1.2);
  const beam = ramp(f, F(b.ai) + 10, F(0.5));

  const gaugeK = (Math.min(G_MAX, p.h) - G_MIN) / (G_MAX - G_MIN);
  const stars = useMemo(() => Array.from({ length: 90 }, (_, i) => new THREE.Vector3((rand(i) - 0.5) * 60, rand(i + 99) * 22 - 2, -14 - rand(i + 7) * 20)), []);

  return (
    <>
      <fog attach="fog" args={[P.night, 22, 48]} />
      <ambientLight intensity={0.75} />
      <directionalLight position={[6, 10, 8]} intensity={2.4} />
      <pointLight position={[-6, 3, 5]} intensity={30} color={P.stamp} distance={18} />
      <pointLight position={[6, 3, 5]} intensity={26} color={SEA} distance={18} />
      <pointLight position={[cp.x, cp.y, cp.z]} intensity={capsuleOn ? 16 : 0} color={GOLD} distance={6} />

      {stars.map((s, i) => (
        <mesh key={i} position={s}><sphereGeometry args={[0.04 + rand(i + 3) * 0.05, 6, 6]} /><meshBasicMaterial color={P.paper} transparent opacity={0.25 + 0.35 * rand(i + 5)} /></mesh>
      ))}
      {/* the sea floor: a faint grid with a glow under each side */}
      <gridHelper args={[60, 60, "#2a3a7a", "#16225a"]} position={[0, -1.6, 0]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[VAULT.x, -1.58, 0]}><circleGeometry args={[3.2, 64]} /><meshBasicMaterial color={P.stamp} transparent opacity={0.08} /></mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[HL.x, -1.58, 0]}><circleGeometry args={[3.2, 64]} /><meshBasicMaterial color={SEA} transparent opacity={0.12} /></mesh>

      {/* ---- the vault on NEAR ---- */}
      <group position={VAULT}>
        <mesh position={[0, -1.25, 0]}><cylinderGeometry args={[1.7, 1.9, 0.5, 6]} /><meshPhysicalMaterial color="#142257" roughness={0.5} clearcoat={0.4} /></mesh>
        <RoundedBox args={[2.0, 2.0, 1.8]} radius={0.12} smoothness={5} position={[0, 0, -0.05]}>
          <meshPhysicalMaterial color="#1c2b6b" metalness={0.55} roughness={0.32} clearcoat={0.8} />
        </RoundedBox>
        {/* inner glow, visible when the door swings open */}
        <mesh position={[0, 0, 0.84]}><planeGeometry args={[1.5, 1.5]} /><meshBasicMaterial color={GOLD} transparent opacity={0.85 * open} /></mesh>
        {[-0.3, 0, 0.3].map((y, i) => (
          <mesh key={i} position={[0, y - 0.25, 0.6]} ><boxGeometry args={[1.1, 0.12, 0.4]} /><meshStandardMaterial color={GOLD} emissive={GOLD} emissiveIntensity={0.6 * open} metalness={0.8} roughness={0.25} transparent opacity={open} /></mesh>
        ))}
        {/* the door, hinged on its left edge */}
        <group position={[-0.82, 0, 0.88]} rotation={[0, -1.9 * open, 0]}>
          <group position={[0.82, 0, 0]}>
            <RoundedBox args={[1.64, 1.64, 0.14]} radius={0.06} smoothness={4}>
              <meshPhysicalMaterial color={refused > 0 ? P.danger : "#2a3c8e"} metalness={0.6} roughness={0.28} clearcoat={1}
                emissive={P.danger} emissiveIntensity={refused * 0.9} />
            </RoundedBox>
            <mesh position={[0, 0, 0.09]}><torusGeometry args={[0.42, 0.06, 16, 48]} /><meshStandardMaterial color={P.paper} metalness={0.9} roughness={0.2} /></mesh>
            <group position={[0, 0, 0.1]} rotation={[0, 0, open * 3 + refused * Math.sin(f) * 0.2]}>
              {[0, 1, 2].map((i) => <mesh key={i} rotation={[0, 0, (i * Math.PI) / 3]}><boxGeometry args={[0.7, 0.07, 0.07]} /><meshStandardMaterial color={P.paper} metalness={0.9} roughness={0.2} /></mesh>)}
            </group>
            <mesh position={[0, 0, 0.11]}><circleGeometry args={[0.12, 24]} /><meshStandardMaterial color={P.stamp} emissive={P.stamp} emissiveIntensity={0.5} /></mesh>
          </group>
        </group>
      </group>
      {/* the one lock the keeper's key fits: "rescue" */}
      <group position={LOCK}>
        <mesh><cylinderGeometry args={[0.32, 0.36, 0.22, 32]} /><meshPhysicalMaterial color={lockLit > 0.5 ? NEAR_GREEN : "#2a3c8e"} metalness={0.5} roughness={0.3}
          emissive={refused > 0 ? P.danger : NEAR_GREEN} emissiveIntensity={lockLit * 0.9 + refused * 1.2} /></mesh>
        <mesh position={[0, 0.115, 0]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[0.06, 0.24]} /><meshBasicMaterial color="#05091c" /></mesh>
        {refused > 0 && <mesh rotation={[-Math.PI / 2, 0, 0]} scale={1 + (1 - refused) * 3}><ringGeometry args={[0.4, 0.5, 48]} /><meshBasicMaterial color={P.danger} transparent opacity={refused} side={THREE.DoubleSide} /></mesh>}
        {lockLit > 0 && <mesh rotation={[-Math.PI / 2, 0, 0]} scale={1 + ramp(f, F(b.vault) - 6, 18) * 2.5}><ringGeometry args={[0.4, 0.46, 48]} /><meshBasicMaterial color={NEAR_GREEN} transparent opacity={(1 - ramp(f, F(b.vault) - 6, 18)) * 0.9} side={THREE.DoubleSide} /></mesh>}
      </group>

      {/* ---- Hyperliquid: a floating hex platform with candles and the health gauge ---- */}
      <group position={HL}>
        <mesh><cylinderGeometry args={[2.0, 2.0, 0.34, 6]} /><meshPhysicalMaterial color="#0e2fb3" roughness={0.35} clearcoat={0.8} /></mesh>
        <mesh position={[0, 0.18, 0]} rotation={[-Math.PI / 2, 0, Math.PI / 6]}><ringGeometry args={[1.8, 1.95, 6]} /><meshBasicMaterial color="#8fb0ff" transparent opacity={0.5} /></mesh>
        {[-1.1, -0.75, -0.4, -0.05, 0.3].map((x, i) => {
          const fallK = ramp(f, F(b.hl), F(b.keeper - b.hl) + 12, INOUT);
          const hgt = 0.5 + 0.55 * rand(i + 11) - (i >= 2 ? fallK * 0.12 * (i - 1) : 0);
          const red = i >= 2 && fallK > 0.2;
          return <mesh key={i} position={[x, 0.17 + hgt / 2 + 0.1 * rand(i), -0.4]}><boxGeometry args={[0.18, hgt, 0.18]} />
            <meshStandardMaterial color={red ? P.danger : NEAR_GREEN} emissive={red ? P.danger : NEAR_GREEN} emissiveIntensity={0.35} /></mesh>;
        })}
      </group>
      <group position={GAUGE}>
        <mesh position={[0, G_H / 2, 0]}><cylinderGeometry args={[0.26, 0.26, G_H, 32, 1, true]} /><meshPhysicalMaterial color="#dfe7ff" transparent opacity={0.16} roughness={0.05} side={THREE.DoubleSide} /></mesh>
        <mesh position={[0, (gaugeK * G_H) / 2, 0]} scale={[1, Math.max(0.001, gaugeK), 1]}><cylinderGeometry args={[0.2, 0.2, G_H, 32]} />
          <meshStandardMaterial color={p.hColor} emissive={p.hColor} emissiveIntensity={0.7} /></mesh>
        {/* the liquidation line (1.0) and the trigger line (1.5) */}
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.28, 0.42, 40]} /><meshBasicMaterial color={P.danger} side={THREE.DoubleSide} /></mesh>
        <mesh position={[0, ((1.5 - G_MIN) / (G_MAX - G_MIN)) * G_H, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.28, 0.36, 40]} /><meshBasicMaterial color={P.mark} side={THREE.DoubleSide} /></mesh>
        {splash > 0 && splash < 1 && <mesh position={[0, 0.2, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={1 + splash * 4}><ringGeometry args={[0.3, 0.38, 48]} /><meshBasicMaterial color={GOLD} transparent opacity={1 - splash} side={THREE.DoubleSide} /></mesh>}
      </group>

      {/* ---- NEAR Intents arc and the USDC capsule ---- */}
      <mesh geometry={tube}><meshStandardMaterial color={NEAR_GREEN} emissive={NEAR_GREEN} emissiveIntensity={1.1} /></mesh>
      <mesh geometry={glowTube}><meshBasicMaterial color={NEAR_GREEN} transparent opacity={0.14} depthWrite={false} /></mesh>
      {draw >= 1 && Array.from({ length: 6 }).map((_, i) => {
        const t = ((f / fps) * 0.35 + i / 6) % 1;
        const v = ARC.getPoint(t);
        return <mesh key={i} position={v}><sphereGeometry args={[0.07, 12, 12]} /><meshBasicMaterial color="#c9ffe9" transparent opacity={0.8 * (1 - ramp(f, F(b.attack), 20))} /></mesh>;
      })}
      {capsuleOn && (
        <group position={cp} quaternion={q} scale={1 - ramp(f, F(b.landed), 6)}>
          <mesh><capsuleGeometry args={[0.2, 0.5, 8, 24]} /><meshPhysicalMaterial color={GOLD} emissive={GOLD} emissiveIntensity={1.2} metalness={0.4} roughness={0.2} clearcoat={1} /></mesh>
          <mesh scale={1.9}><capsuleGeometry args={[0.2, 0.5, 8, 16]} /><meshBasicMaterial color={GOLD} transparent opacity={0.15} depthWrite={false} /></mesh>
        </group>
      )}
      {capsuleOn && Array.from({ length: 10 }).map((_, i) => {
        const t = Math.max(0, ride - (i + 1) * 0.018);
        const v = ARC.getPoint(t);
        return <mesh key={i} position={v}><sphereGeometry args={[0.07 * (1 - i / 11), 8, 8]} /><meshBasicMaterial color={GOLD} transparent opacity={0.7 * (1 - i / 10)} /></mesh>;
      })}

      {/* ---- keepers ---- */}
      <Drone pos={dronePos} f={f} color="#e9edff" keyColor={GOLD} tilt={(1 - kIn) * 0.2 - lift * 0.15} opacity={ramp(f, F(b.keeper) - 10, 10)} />
      {attackOn && <Drone pos={aPos.clone().add(new THREE.Vector3(shake, 0, 0))} f={f} color="#3a1220" keyColor={P.danger} tilt={-0.2 * (1 - aIn) + shake * 3} opacity={ramp(f, F(b.attack), 8) * (1 - ramp(f, F(b.attack) + F(2.5), 10))} />}

      {/* ---- NEAR AI Cloud satellite ---- */}
      {f >= F(b.ai) && (
        <group position={sat} scale={0.8 + 0.7 * aiK} rotation={[0.3, f / 50, 0.15]}>
          <mesh><octahedronGeometry args={[0.32, 0]} /><meshPhysicalMaterial color="#8fb0ff" emissive="#8fb0ff" emissiveIntensity={0.6} metalness={0.5} roughness={0.2} clearcoat={1} /></mesh>
          {[-1, 1].map((s) => <mesh key={s} position={[s * 0.75, 0, 0]}><boxGeometry args={[0.6, 0.02, 0.3]} /><meshStandardMaterial color="#8fb0ff" emissive="#1d4bff" emissiveIntensity={0.3} metalness={0.6} roughness={0.3} /></mesh>)}
        </group>
      )}
      {beam > 0 && (() => {
        const a = sat, z = GAUGE.clone().add(new THREE.Vector3(0, G_H * 0.6, 0));
        const mid = a.clone().lerp(z, beam * 0.5), len = a.distanceTo(z) * beam;
        const dir = z.clone().sub(a).normalize();
        const qq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        return <mesh position={mid} quaternion={qq}><cylinderGeometry args={[0.025, 0.025, len, 8]} /><meshBasicMaterial color="#8fb0ff" transparent opacity={0.8} /></mesh>;
      })()}
    </>
  );
};
