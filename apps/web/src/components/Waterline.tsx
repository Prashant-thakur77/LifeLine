"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { formatHealth } from "../lib/format";
import { GAUGE_MAX } from "../lib/gauge";
import { hullY, settle, type Spring } from "../lib/waterline";
import { Mark } from "./Shell";
import { cx } from "./ui";

export type Levels = { warn: number; trigger: number; target: number };
export type WaterTone = "safe" | "warn" | "rescue" | "liquidation" | "none" | "unknown";

const TONE: Record<WaterTone, string> = {
  safe: "62 211 162",
  warn: "244 182 63",
  rescue: "255 122 61",
  liquidation: "255 82 102",
  none: "147 165 179",
  unknown: "244 182 63",
};

type Props = {
  /** The health the water settles at. Null means no trusted reading: the water stays put and is hatched, never lowered. */
  health: number | null;
  levels: Levels;
  tone: WaterTone;
  /** Increment to throw the line (a rescue landed). */
  throwSignal: number;
  /** Increment to ping the surface (a fresh reading arrived). */
  pingSignal: number;
  reduced: boolean;
  /** The label carried down the line, such as "+3.47 USDC". */
  throwLabel?: string | null;
  /** Fraction of the height where health 1.0 sits. */
  scaleTop?: number;
  /** The health at the bottom of the scale: 4.0, or less for a short panel. */
  scaleMax?: number;
  /** Fraction of the width covered by text: the surface line and hairlines stay quiet there. */
  quietLeft?: number;
  /** Names where the line is thrown from, such as the vault. */
  anchorLabel?: string;
  /** "hero" spans the viewport; "panel" fits inside a card. */
  size?: "hero" | "panel";
  /** Rides the surface: the readout. */
  surface?: ReactNode;
  className?: string;
};

const SEA_STATE: Record<WaterTone, number> = { safe: 0.55, none: 0.5, warn: 0.85, unknown: 0.7, rescue: 1.2, liquidation: 1.3 };

const ROPE_REVEAL_MS = 240;
const ROPE_HOLD_MS = 2600;
const ROPE_FADE_MS = 500;
const PING_MS = 1300;

/**
 * The landing page's signature: health drawn as a sea level against a load line painted
 * on a hull. Falling health is rising water. A rescue throws an orange line from the
 * reserve and the water drops back. One animation loop draws the canvas and moves the
 * surface layer directly, so React only renders when the reading changes.
 */
export function Waterline({
  health,
  levels,
  tone,
  throwSignal,
  pingSignal,
  reduced,
  throwLabel,
  scaleTop = 0.14,
  scaleMax = GAUGE_MAX,
  quietLeft = 0,
  anchorLabel,
  size = "hero",
  surface,
  className,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const rope = useRef<SVGSVGElement>(null);
  const ropePath = useRef<SVGPathElement>(null);
  const ropeTwist = useRef<SVGPathElement>(null);
  const ropeTag = useRef<HTMLDivElement>(null);
  const ladder = useRef<HTMLDivElement>(null);
  const anchorSquare = useRef<HTMLSpanElement>(null);
  const tag = useRef<HTMLSpanElement>(null);
  const rider = useRef<HTMLDivElement>(null);

  // Everything the loop reads lives in one ref, so props can change without restarting it.
  const live = useRef({
    target: health === null ? null : hullY(health, scaleTop, scaleMax),
    tone,
    reduced,
    scaleTop,
    spring: null as Spring | null,
    throwAt: -Infinity,
    pingAt: -Infinity,
    size: { w: 0, h: 0, dpr: 1 },
    /** Where the line lands and the ping rings: just right of the readout. */
    focusX: 0,
    /** Where the line is thrown from: the top of the load line's spine. */
    anchor: { x: 0, y: 0 },
    quietLeft,
    sea: SEA_STATE[tone],
    wake: () => {},
  });

  useEffect(() => {
    const s = live.current;
    s.target = health === null ? null : hullY(health, scaleTop, scaleMax);
    s.quietLeft = quietLeft;
    s.tone = tone;
    s.reduced = reduced;
    s.scaleTop = scaleTop;
    if (s.spring === null && s.target !== null) s.spring = { value: s.target, velocity: 0 };
    s.wake();
  }, [health, tone, reduced, scaleTop, scaleMax, quietLeft]);

  const lastThrow = useRef(throwSignal);
  useEffect(() => {
    if (throwSignal === lastThrow.current) return;
    lastThrow.current = throwSignal;
    const rect = box.current?.getBoundingClientRect();
    const readout = rider.current?.firstElementChild?.getBoundingClientRect();
    if (rect && readout && readout.width > 0) live.current.focusX = Math.min(rect.width - 24, readout.right - rect.left + 18);
    live.current.throwAt = performance.now();
    live.current.wake();
  }, [throwSignal]);

  const lastPing = useRef(pingSignal);
  useEffect(() => {
    if (pingSignal === lastPing.current) return;
    lastPing.current = pingSignal;
    if (!live.current.reduced) live.current.pingAt = performance.now();
    live.current.wake();
  }, [pingSignal]);

  useEffect(() => {
    const el = box.current;
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!el || !cv || !ctx) return;
    const s = live.current;

    const resize = () => {
      const rect = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      s.size = { w: rect.width, h: rect.height, dpr };
      cv.width = Math.round(rect.width * dpr);
      cv.height = Math.round(rect.height * dpr);
      rope.current?.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
      const readout = rider.current?.firstElementChild?.getBoundingClientRect();
      s.focusX = readout && readout.width > 0 ? Math.min(rect.width - 24, readout.right - rect.left + 18) : rect.width * 0.6;
      const square = anchorSquare.current?.getBoundingClientRect();
      const spine = ladder.current?.getBoundingClientRect();
      s.anchor = square
        ? { x: square.left + square.width / 2 - rect.left, y: square.top + square.height / 2 - rect.top }
        : spine
          ? { x: spine.left - rect.left, y: spine.top - rect.top - 30 }
          : { x: rect.width * 0.95, y: 12 };
      s.wake();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);

    let frame = 0;
    let running = false;
    let visible = true;
    let last = performance.now();
    const born = last;

    const draw = (now: number) => {
      const { w, h, dpr } = s.size;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (s.target !== null && s.spring) s.spring = s.reduced ? { value: s.target, velocity: 0 } : settle(s.spring, s.target, dt);
      const level = (s.spring?.value ?? 1) * h;
      const trusted = s.target !== null;
      const t = (now - born) / 1000;
      // Sea state follows stress: nearly still when safe, a little rougher toward liquidation. Never frantic.
      s.sea += (SEA_STATE[s.tone] - s.sea) * Math.min(1, dt * 1.2);
      const amp = s.reduced ? 0 : Math.max(2.5, Math.min(6, h / 110)) * s.sea;
      const wave = (x: number, phase: number, k: number) =>
        Math.sin(x * k + t * 0.9 + phase) * amp + Math.sin(x * k * 0.47 - t * 0.55 + phase * 2) * amp * 0.6;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      if (s.spring) {
        // Back swell, then the body, then the surface line.
        const back = ctx.createLinearGradient(0, level - 20, 0, h);
        back.addColorStop(0, "rgba(64, 160, 168, 0.10)");
        back.addColorStop(1, "rgba(64, 160, 168, 0.02)");
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let x = 0; x <= w + 8; x += 8) ctx.lineTo(x, level - 6 + wave(x, 1.7, 0.011));
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = back;
        ctx.fill();

        const body = ctx.createLinearGradient(0, level, 0, h);
        body.addColorStop(0, trusted ? "rgba(18, 84, 96, 0.62)" : "rgba(60, 60, 50, 0.4)");
        body.addColorStop(0.35, trusted ? "rgba(8, 40, 54, 0.78)" : "rgba(30, 30, 28, 0.55)");
        body.addColorStop(1, "rgba(4, 14, 22, 0.94)");
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let x = 0; x <= w + 8; x += 8) ctx.lineTo(x, level + wave(x, 0, 0.016));
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = body;
        ctx.fill();

        ctx.beginPath();
        for (let x = 0; x <= w + 8; x += 8) {
          const y = level + wave(x, 0, 0.016);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        const strong = trusted ? 0.9 : 0.6;
        if (s.quietLeft > 0) {
          const fadeTo = Math.min(1, s.quietLeft + 0.08);
          const stroke = ctx.createLinearGradient(0, 0, w, 0);
          stroke.addColorStop(0, `rgb(${TONE[s.tone]} / 0.16)`);
          stroke.addColorStop(s.quietLeft, `rgb(${TONE[s.tone]} / 0.16)`);
          stroke.addColorStop(fadeTo, `rgb(${TONE[s.tone]} / ${strong})`);
          ctx.strokeStyle = stroke;
        } else {
          ctx.strokeStyle = `rgb(${TONE[s.tone]} / ${strong})`;
        }
        ctx.lineWidth = 1.5;
        ctx.setLineDash(trusted ? [] : [6, 6]);
        ctx.stroke();
        ctx.setLineDash([]);

        // A sonar ping where a fresh reading arrived.
        const ping = (now - s.pingAt) / PING_MS;
        if (ping >= 0 && ping < 1) {
          const px = s.focusX;
          const py = level + wave(px, 0, 0.016);
          ctx.beginPath();
          ctx.ellipse(px, py, 10 + ping * 90, 3 + ping * 18, 0, 0, Math.PI * 2);
          ctx.strokeStyle = `rgb(${TONE[s.tone]} / ${0.55 * (1 - ping)})`;
          ctx.lineWidth = 1.25;
          ctx.stroke();
        }
      }

      if (rider.current) {
        rider.current.style.transform = `translate3d(0, ${level}px, 0)`;
        // Nothing to ride until there's a first reading.
        rider.current.style.opacity = s.spring ? "1" : "0";
      }

      // The throw line: from the deck, off the top right, down to the surface.
      const since = now - s.throwAt;
      const ropeOn = since >= 0 && since < ROPE_HOLD_MS + ROPE_FADE_MS;
      if (ropePath.current && ropeTwist.current && rope.current) {
        if (ropeOn) {
          const ex = s.focusX;
          const ey = level + wave(ex, 0, 0.016);
          const sx = s.anchor.x;
          const sy = s.anchor.y;
          const reveal = s.reduced ? 1 : Math.min(1, since / ROPE_REVEAL_MS);
          const easeOut = 1 - (1 - reveal) ** 3;
          const taut = s.reduced ? 1 : Math.min(1, Math.max(0, (since - ROPE_REVEAL_MS) / 700));
          // The line arcs out from the reserve over the top, then drops into the gap beside the
          // readout: it never crosses the load-line labels, the disc or the readout. It starts
          // slack and pulls taut; it never dips under the surface.
          const slack = h * 0.16 * (1 - taut);
          const cx = ex + (sx - ex) * 0.08;
          const cy = Math.min(ey - 6, sy + (ey - sy) * 0.12 + slack);
          const d = `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`;
          const fade = since > ROPE_HOLD_MS ? 1 - (since - ROPE_HOLD_MS) / ROPE_FADE_MS : 1;
          ropePath.current.setAttribute("d", d);
          ropeTwist.current.setAttribute("d", d);
          const length = ropePath.current.getTotalLength();
          for (const p of [ropePath.current, ropeTwist.current]) {
            p.style.strokeDasharray = p === ropePath.current ? `${length}` : `2 7`;
            p.style.strokeDashoffset = p === ropePath.current ? `${length * (1 - easeOut)}` : "0";
          }
          ropeTwist.current.style.opacity = easeOut >= 1 ? "1" : "0";
          rope.current.style.opacity = String(Math.max(0, fade));
          if (ropeTag.current) {
            ropeTag.current.style.opacity = String(easeOut >= 1 ? Math.max(0, fade) : 0);
            ropeTag.current.style.transform = `translate3d(${ex}px, ${ey}px, 0)`;
          }
          if (tag.current) {
            // Below and left of the buoy, but never off the panel's edge.
            const tw = tag.current.offsetWidth;
            const tx = Math.max(12, Math.min(w - tw - 12, ex - tw - 10));
            tag.current.style.transform = `translate3d(${tx - ex}px, 18px, 0)`;
          }
        } else {
          rope.current.style.opacity = "0";
          if (ropeTag.current) ropeTag.current.style.opacity = "0";
        }
      }

      const moving =
        !s.reduced ||
        (s.spring !== null && s.target !== null && Math.abs(s.spring.value - s.target) > 0.0005) ||
        ropeOn;
      if (visible && moving && !document.hidden) frame = requestAnimationFrame(draw);
      else running = false;
    };

    s.wake = () => {
      if (running || !visible) return;
      running = true;
      last = performance.now();
      frame = requestAnimationFrame(draw);
    };

    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible) s.wake();
    });
    io.observe(el);
    const onVisibility = () => {
      if (!document.hidden) s.wake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    resize();
    s.wake();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      s.wake = () => {};
    };
  }, []);

  const within = (health: number) => (hullY(health, scaleTop, scaleMax) - scaleTop) / (1 - scaleTop);
  const marks = [
    { key: "liq", label: "Liquidation", value: 1, tone: "danger" },
    { key: "trigger", label: "Rescue", value: levels.trigger, tone: "rescue" },
    { key: "warn", label: "Warn", value: levels.warn, tone: "warn" },
    { key: "target", label: "Refill", value: levels.target, tone: "safe" },
  ] as const;

  return (
    <div
      ref={box}
      className={cx(
        "overflow-hidden",
        size === "hero"
          ? "[--disc-w:84px] [--ladder-r:12px] [--ladder-w:128px] sm:[--ladder-w:190px] lg:[--disc-w:104px] lg:[--ladder-r:4%] lg:[--ladder-w:170px] xl:[--disc-w:124px] xl:[--ladder-w:250px]"
          : "[--disc-w:84px] [--ladder-r:16px] [--ladder-w:128px] sm:[--ladder-w:210px]",
        className ?? "relative",
      )}
    >
      {/* The load line, painted on the hull. Below the surface it shows through the water, dimmed. */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        {[
          { value: 1, className: "bg-danger/25" },
          { value: levels.trigger, className: "bg-rescue/25" },
        ].map((line) => (
          <div
            key={line.value}
            className={cx("absolute right-0 h-px", line.className)}
            style={{ top: pct(hullY(line.value, scaleTop, scaleMax)), left: pct(quietLeft) }}
          />
        ))}
        <div ref={ladder} className="absolute bottom-0 right-[var(--ladder-r)] w-[var(--ladder-w)]" style={{ top: pct(scaleTop) }}>
          {anchorLabel ? (
            <div className="absolute bottom-full left-0 mb-5 flex -translate-x-[5px] items-center gap-2 whitespace-nowrap">
              <span ref={anchorSquare} className="size-[10px] bg-rescue" />
              <span className="font-readout text-[11px] text-paper/80">{anchorLabel}</span>
            </div>
          ) : null}
          <div className="absolute inset-y-0 left-0 w-[3px] -translate-x-1/2 bg-paper/45" />
          {marks.map((mark) => (
            <div key={mark.key} className="absolute inset-x-0 flex -translate-y-1/2 items-center gap-2 sm:gap-3" style={{ top: pct(within(mark.value)) }}>
              <div className={cx("h-[4px] w-[18%] shrink-0 sm:w-[30%]", MARK_BAR[mark.tone])} />
              <div className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap leading-none sm:gap-2">
                <span className="font-stencil text-[12px] uppercase tracking-[0.04em] text-paper/80 sm:text-[15px]">
                  {mark.key === "liq" ? (
                    <>
                      <span className="sm:hidden">Liq.</span>
                      <span className="hidden sm:inline">{mark.label}</span>
                    </>
                  ) : (
                    mark.label
                  )}
                </span>
                <span className={cx("num text-[12px] sm:text-[14px]", MARK_TEXT[mark.tone])}>{formatHealth(mark.value)}</span>
              </div>
            </div>
          ))}
          {/* The disc, as on a ship's hull: a ring crossed by a bar, on the line the user set. */}
          <div className="absolute right-full hidden w-[var(--disc-w)] -translate-y-1/2 pr-[6%] sm:block" style={{ top: pct(within(levels.trigger)) }}>
            <svg viewBox="0 0 160 120" className="block w-full overflow-visible">
              <circle cx="60" cy="60" r="50" fill="none" stroke="var(--color-rescue)" strokeOpacity="0.85" strokeWidth="9" />
              <rect x="-4" y="55.5" width="128" height="9" fill="var(--color-rescue)" />
              <line x1="124" y1="60" x2="172" y2="60" stroke="var(--color-rescue)" strokeOpacity="0.55" strokeWidth="3" strokeDasharray="6 5" />
            </svg>
            <p className="absolute left-0 top-full mt-2 w-[75%] text-center font-stencil text-[12px] uppercase tracking-[0.06em] text-rescue lg:text-[13px]">
              Your trigger
            </p>
          </div>
          <div className="num absolute bottom-3 left-3 text-[11px] text-mist-100">{formatHealth(scaleMax)}+</div>
        </div>
      </div>

      <canvas ref={canvas} className="pointer-events-none absolute inset-0 size-full" aria-hidden />

      <svg ref={rope} className="pointer-events-none absolute inset-0 size-full opacity-0" aria-hidden>
        <path ref={ropePath} fill="none" stroke="var(--color-rescue)" strokeWidth="4" strokeLinecap="round" />
        <path ref={ropeTwist} fill="none" stroke="var(--color-paper)" strokeOpacity="0.65" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      {throwLabel ? (
        <div ref={ropeTag} className="pointer-events-none absolute left-0 top-0 opacity-0" aria-hidden>
          {/* The line ends at a lifebuoy on the water, tagged with what it carries and where it goes. */}
          <span className="absolute -left-[13px] -top-[13px] block size-[26px] rounded-full bg-ink-950/60">
            <Mark className="size-full" />
          </span>
          <span ref={tag} className="num absolute left-0 top-0 block whitespace-nowrap rounded-sm bg-rescue px-2 py-1 text-[12.5px] font-semibold text-ink-950">
            {throwLabel}
          </span>
        </div>
      ) : null}

      <div ref={rider} className="pointer-events-none absolute inset-x-0 top-0 opacity-0 will-change-transform">
        {surface}
      </div>
    </div>
  );
}

const pct = (fraction: number) => `${(fraction * 100).toFixed(3)}%`;

const MARK_BAR = {
  danger: "bg-danger/80",
  rescue: "bg-rescue",
  warn: "bg-warn/80",
  safe: "bg-[repeating-linear-gradient(90deg,var(--color-safe)_0_9px,transparent_9px_14px)]",
} as const;

const MARK_TEXT = { danger: "text-danger", rescue: "text-rescue", warn: "text-warn", safe: "text-safe" } as const;
