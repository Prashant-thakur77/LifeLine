"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMinWidth } from "../hooks/useMinWidth";
import { formatHealth } from "../lib/format";
import { GAUGE_MAX } from "../lib/gauge";
import { hullY, settle, sheetWidth, wavePath, type Spring } from "../lib/waterline";
import { Mark } from "./Shell";
import { cx } from "./ui";

export type Levels = { warn: number; trigger: number; target: number };
export type WaterTone = "safe" | "warn" | "rescue" | "liquidation" | "none" | "unknown";

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
  /** The label carried down the line, such as "+3.47 USDC → 0x1111…1111". */
  throwLabel?: string | null;
  /** Fraction of the height where health 1.0 sits. */
  scaleTop?: number;
  /** The health at the bottom of the scale: 4.0, or less for a short panel. */
  scaleMax?: number;
  /**
   * The scale on wide screens (1024 px and up), if different. Applied in CSS, so the
   * page renders at the right proportions before any script runs and nothing jumps.
   */
  wideScale?: { top: number; max: number };
  /** Names where the line is thrown from, such as the vault. */
  anchorLabel?: ReactNode;
  /** "hero" spans the page; "panel" fits inside a card. */
  size?: "hero" | "panel";
  /** Rides the surface: the readout. */
  surface?: ReactNode;
  className?: string;
};

/** Four sheets of cut paper, back to front: lighter and higher behind, deeper in front. Each drifts at its own pace. */
const WAVES = [
  { fill: "#b7ccff", rise: -16, amp: 7, period: 520, seconds: 58, reverse: false },
  { fill: "#6f93ff", rise: -7, amp: 8, period: 760, seconds: 44, reverse: true },
  { fill: "#1d4bff", rise: 0, amp: 6, period: 640, seconds: 36, reverse: false },
  { fill: "#0e2fb3", rise: 26, amp: 7, period: 900, seconds: 50, reverse: true },
] as const;

/** Room above each sheet's outline for its crest and shadow. */
const SHEET_PAD = 40;

const ROPE_REVEAL_MS = 260;
const ROPE_HOLD_MS = 2600;
const ROPE_FADE_MS = 500;

/**
 * The signature: health as the sea level against a load line printed on an orange
 * paper hull. Falling health is rising water. A rescue throws a line from the reserve,
 * a lifebuoy lands with a splash, and the water drops back. The waves drift by CSS;
 * one loop moves the sea and the readout, and only while something is moving.
 */
export function Waterline({
  health,
  levels,
  tone,
  throwSignal,
  pingSignal,
  reduced,
  throwLabel,
  scaleTop = 0.16,
  scaleMax = GAUGE_MAX,
  wideScale,
  anchorLabel,
  size = "hero",
  surface,
  className,
}: Props) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const box = useRef<HTMLDivElement>(null);
  const sea = useRef<HTMLDivElement>(null);
  const rope = useRef<SVGSVGElement>(null);
  const ropePath = useRef<SVGPathElement>(null);
  const ropeTwist = useRef<SVGPathElement>(null);
  const buoy = useRef<HTMLDivElement>(null);
  const tag = useRef<HTMLSpanElement>(null);
  const splash = useRef<HTMLDivElement>(null);
  const ping = useRef<HTMLSpanElement>(null);
  const rider = useRef<HTMLDivElement>(null);
  const ladder = useRef<HTMLDivElement>(null);
  const anchorSquare = useRef<HTMLSpanElement>(null);
  const [dims, setDims] = useState({ w: 1200, h: 600 });
  // The water itself moves by script, so it follows whichever scale is showing.
  const wide = useMinWidth(1024);
  const scale = wideScale && wide ? wideScale : { top: scaleTop, max: scaleMax };

  const live = useRef({
    target: health === null ? null : hullY(health, scale.top, scale.max),
    reduced,
    spring: null as Spring | null,
    throwAt: -Infinity,
    splashed: true,
    h: 600,
    w: 1200,
    focusX: 0,
    anchor: { x: 0, y: 0 },
    /** The readout's height, so it never rides above the top edge. */
    lift: 0,
    /** The rescue tag's width, so it stays inside the stage. */
    tagW: 0,
    wake: () => {},
  });

  /** Where the line starts (the reserve tag) and lands (beside the readout), from the layout as it is now. */
  const measure = () => {
    const el = box.current;
    if (!el) return;
    const s = live.current;
    const rect = el.getBoundingClientRect();
    const readout = rider.current?.firstElementChild?.getBoundingClientRect();
    s.focusX = readout && readout.width > 0 ? Math.min(rect.width - 24, readout.right - rect.left + 22) : rect.width * 0.5;
    const square = anchorSquare.current?.getBoundingClientRect();
    s.anchor = square ? { x: square.left + square.width / 2 - rect.left, y: square.top + square.height / 2 - rect.top } : { x: rect.width * 0.7, y: 10 };
    // The readout sits inside the rider, often absolutely, so measure the readout itself.
    s.lift = (rider.current?.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
    s.tagW = tag.current?.offsetWidth ?? 0;
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;

  useEffect(() => {
    const s = live.current;
    s.target = health === null ? null : hullY(health, scale.top, scale.max);
    s.reduced = reduced;
    // The first reading fills the sea from below rather than appearing at its level.
    if (s.spring === null && s.target !== null) s.spring = { value: reduced ? s.target : 1, velocity: 0 };
    s.wake();
  }, [health, reduced, scale.top, scale.max]);

  useEffect(() => {
    measureRef.current();
  }, [scale.top, scale.max, size, dims]);

  const lastThrow = useRef(throwSignal);
  useEffect(() => {
    if (throwSignal === lastThrow.current) return;
    lastThrow.current = throwSignal;
    measureRef.current();
    live.current.throwAt = performance.now();
    live.current.splashed = false;
    live.current.wake();
  }, [throwSignal]);

  const lastPing = useRef(pingSignal);
  useEffect(() => {
    if (pingSignal === lastPing.current) return;
    lastPing.current = pingSignal;
    if (live.current.reduced || !ping.current) return;
    ping.current.style.left = `${live.current.focusX}px`;
    ping.current.animate(
      [
        { transform: "translate(-50%, -50%) scale(0.2, 0.08)", opacity: 0.9 },
        { transform: "translate(-50%, -50%) scale(1, 0.3)", opacity: 0 },
      ],
      { duration: 1400, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
    );
  }, [pingSignal]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const s = live.current;
    const resize = () => {
      const rect = el.getBoundingClientRect();
      s.w = rect.width;
      s.h = rect.height;
      const next = { w: Math.round(rect.width), h: Math.round(rect.height) };
      setDims((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
      measureRef.current();
      s.wake();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    // The readout changes height when its text wraps differently; remeasure then too.
    const readout = rider.current?.firstElementChild;
    if (readout) observer.observe(readout);

    let frame = 0;
    let running = false;
    let last = performance.now();

    const splashNow = (x: number, y: number) => {
      const holder = splash.current;
      if (!holder || s.reduced) return;
      holder.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      [...holder.children].forEach((child, i) => {
        const angle = -Math.PI / 2 + (i - (holder.children.length - 1) / 2) * 0.45;
        const dist = 26 + (i % 3) * 10;
        (child as HTMLElement).animate(
          [
            { transform: "translate(-50%, -50%) scale(0.4)", opacity: 1 },
            { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px)) scale(1)`, opacity: 1, offset: 0.55 },
            { transform: `translate(calc(-50% + ${Math.cos(angle) * dist * 1.25}px), calc(-50% + ${Math.sin(angle) * dist * 0.3 + 18}px)) scale(0.6)`, opacity: 0 },
          ],
          { duration: 620, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" },
        );
      });
    };

    // What the loop last wrote, so a frame where nothing moved writes nothing and repaints nothing.
    const wrote = { level: "", rider: "", shown: "", d: "", revealed: false };

    const draw = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const h = s.h;
      if (s.target !== null && s.spring) s.spring = s.reduced ? { value: s.target, velocity: 0 } : settle(s.spring, s.target, dt);
      const level = (s.spring?.value ?? 1) * h;
      const levelPx = level.toFixed(1);
      if (sea.current && wrote.level !== levelPx) {
        wrote.level = levelPx;
        sea.current.style.transform = `translate3d(0, ${levelPx}px, 0)`;
      }
      if (rider.current) {
        // The readout's own height is measured on resize, never here: reading layout every frame forces it.
        const riderPx = Math.max(level, s.lift + 6).toFixed(1);
        if (wrote.rider !== riderPx) {
          wrote.rider = riderPx;
          rider.current.style.transform = `translate3d(0, ${riderPx}px, 0)`;
        }
        const shown = s.spring ? "1" : "0";
        if (wrote.shown !== shown) {
          wrote.shown = shown;
          rider.current.style.opacity = shown;
        }
      }

      const since = now - s.throwAt;
      const ropeOn = since >= 0 && since < ROPE_HOLD_MS + ROPE_FADE_MS;
      if (ropePath.current && ropeTwist.current && rope.current) {
        if (ropeOn) {
          const ex = s.focusX;
          const ey = Math.round((level - 4) * 2) / 2;
          const { x: sx, y: sy } = s.anchor;
          const reveal = s.reduced ? 1 : Math.min(1, since / ROPE_REVEAL_MS);
          const easeOut = 1 - (1 - reveal) ** 3;
          const taut = s.reduced ? 1 : Math.min(1, Math.max(0, (since - ROPE_REVEAL_MS) / 700));
          // Out over the top from the reserve, then down beside the readout; slack first, then taut.
          const slack = h * 0.14 * (1 - taut);
          const cx = ex + (sx - ex) * 0.1;
          const cy = Math.min(ey - 6, sy + (ey - sy) * 0.12 + slack);
          const d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey}`;
          const fade = since > ROPE_HOLD_MS ? 1 - (since - ROPE_HOLD_MS) / ROPE_FADE_MS : 1;
          const changed = d !== wrote.d;
          if (changed) {
            wrote.d = d;
            ropePath.current.setAttribute("d", d);
            ropeTwist.current.setAttribute("d", d);
          }
          if (easeOut < 1) {
            // Drawn out from the reserve: the dash trick needs the line's length, so only while it's being drawn.
            const length = ropePath.current.getTotalLength();
            ropePath.current.style.strokeDasharray = `${length}`;
            ropePath.current.style.strokeDashoffset = `${length * (1 - easeOut)}`;
            ropeTwist.current.style.opacity = "0";
            wrote.revealed = false;
          } else if (!wrote.revealed) {
            wrote.revealed = true;
            ropePath.current.style.strokeDasharray = "none";
            ropePath.current.style.strokeDashoffset = "0";
            ropeTwist.current.style.opacity = "1";
          }
          rope.current.style.opacity = String(Math.max(0, fade));
          if (buoy.current) {
            buoy.current.style.opacity = String(easeOut >= 1 ? Math.max(0, fade) : 0);
            if (changed) buoy.current.style.transform = `translate3d(${ex}px, ${ey}px, 0)`;
          }
          if (tag.current && changed) {
            const tx = Math.max(12, Math.min(s.w - s.tagW - 12, ex - s.tagW - 22));
            tag.current.style.transform = `translate3d(${tx - ex}px, 30px, 0)`;
          }
          if (easeOut >= 1 && !s.splashed) {
            s.splashed = true;
            splashNow(ex, ey);
          }
        } else if (wrote.d !== "") {
          wrote.d = "";
          rope.current.style.opacity = "0";
          if (buoy.current) buoy.current.style.opacity = "0";
        }
      }

      const moving = (s.spring !== null && s.target !== null && Math.abs(s.spring.value - s.target) > 0.0004) || ropeOn;
      if (moving && !document.hidden) frame = requestAnimationFrame(draw);
      else running = false;
    };

    s.wake = () => {
      if (running) return;
      running = true;
      last = performance.now();
      frame = requestAnimationFrame(draw);
    };
    const onVisibility = () => {
      if (!document.hidden) s.wake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    resize();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      s.wake = () => {};
    };
  }, []);

  const narrow = { top: scaleTop, max: scaleMax };
  const within = (h: number, sc: { top: number; max: number }) => (hullY(h, sc.top, sc.max) - sc.top) / (1 - sc.top);
  /** A vertical position for both scales: CSS picks the wide one at 1024 px and up. */
  const at = (fraction: (sc: { top: number; max: number }) => number) =>
    ({ ["--y" as string]: pct(fraction(narrow)), ["--y-lg" as string]: pct(fraction(wideScale ?? narrow)) }) as CSSProperties;
  const AT = "top-[var(--y)] lg:top-[var(--y-lg)]";
  const pct = (fraction: number) => `${(fraction * 100).toFixed(3)}%`;
  const trusted = health !== null;
  const marks = [
    { key: "liq", label: "Liquidation", short: "Liq.", value: 1, bar: "bg-danger" },
    { key: "trigger", label: "Rescue", short: "Rescue", value: levels.trigger, bar: "bg-ink" },
    { key: "warn", label: "Warn", short: "Warn", value: levels.warn, bar: "bg-sun" },
    { key: "target", label: "Refill", short: "Refill", value: levels.target, bar: "bg-[repeating-linear-gradient(90deg,var(--color-ink)_0_8px,transparent_8px_13px)]" },
  ];
  const { w, h } = dims;
  // The sheets' outlines depend only on the stage's size, so they're built once per size, not on every reading.
  const sheets = useMemo(
    () =>
      WAVES.map((wave, i) => {
        const width = sheetWidth(w, wave.period);
        const height = h + 120;
        const outline = (top: number) => wavePath({ width: w, height, period: wave.period, amp: wave.amp, top });
        return { ...wave, i, width, height, path: outline(wave.rise), dots: i === 3 ? outline(wave.rise + 18) : null };
      }),
    [w, h],
  );

  return (
    <div
      ref={box}
      className={cx(
        "overflow-hidden",
        size === "hero"
          ? "[--hull-r:0px] [--hull-w:44%] sm:[--hull-w:40%] lg:[--hull-r:3%] lg:[--hull-w:34%]"
          : "[--hull-r:0px] [--hull-w:46%] sm:[--hull-w:42%]",
        className ?? "relative",
      )}
    >
      {/* The sun, printed: yellow over a misregistered orange pass. */}
      <div className="pointer-events-none absolute right-[calc(var(--hull-r)+var(--hull-w)-8%)] top-[3%] aspect-square w-[min(20%,190px)]" aria-hidden>
        <span className="absolute inset-0 translate-x-[4px] translate-y-[3px] rounded-full bg-rescue/35 mix-blend-multiply" />
        <span className="absolute inset-0 rounded-full bg-sun mix-blend-multiply" />
        <span className="absolute inset-0 rounded-full bg-[radial-gradient(circle,transparent_58%,rgb(255_247_234/0.9)_59%)] bg-[length:100%_100%]" />
        <span className="absolute inset-[-14%] rounded-full bg-[radial-gradient(var(--color-sun)_1.2px,transparent_1.6px)] bg-[length:9px_9px] opacity-70 [mask-image:radial-gradient(circle,transparent_48%,black_52%,transparent_72%)]" />
      </div>

      {/* The hull: orange paper, with the load line printed on it. */}
      <div
        className={cx(
          "pointer-events-none absolute bottom-0 right-[var(--hull-r)] w-[var(--hull-w)] rounded-tl-[44px] bg-rescue shadow-[0_1px_0_rgb(11_21_51/0.2),0_24px_48px_-24px_rgb(11_21_51/0.55)]",
          AT,
        )}
        style={at((sc) => Math.max(0, sc.top - 0.15))}
        aria-hidden
      >
        <span className="absolute inset-x-0 top-[16px] h-[9px] bg-paper/90" />
        <span className="absolute inset-x-0 top-[30px] h-[3px] bg-ink/80" />
        <span className="absolute left-[22px] right-0 top-[44px] flex gap-[14px] overflow-hidden">
          {Array.from({ length: 24 }, (_, i) => (
            <span key={i} className="size-[5px] shrink-0 rounded-full bg-ink/35" />
          ))}
        </span>
      </div>

      {/* The sea: four sheets of cut paper, drifting, raised and lowered together by health.
          Each sheet is its own layer, painted once and only moved, so the drift costs no repaint. */}
      <div ref={sea} className="pointer-events-none absolute inset-0 will-change-transform" style={{ transform: "translate3d(0, 100%, 0)" }} aria-hidden>
        {sheets.map((sheet) => (
          <div
            key={sheet.i}
            className={cx("wave-drift absolute left-0", !trusted && sheet.i < 3 && "opacity-50")}
            style={{
              top: -SHEET_PAD,
              width: sheet.width,
              height: sheet.height + SHEET_PAD,
              ["--p" as string]: `${sheet.period}px`,
              animationDuration: `${sheet.seconds}s`,
              animationDirection: sheet.reverse ? "reverse" : "normal",
            }}
          >
            <svg width={sheet.width} height={sheet.height + SHEET_PAD} viewBox={`0 ${-SHEET_PAD} ${sheet.width} ${sheet.height + SHEET_PAD}`} className="block">
              <defs>
                <filter id={`lift-${id}-${sheet.i}`} x="-2%" y="-5%" width="104%" height="110%">
                  <feDropShadow dx="0" dy="-3" stdDeviation="2" floodColor="#0b1533" floodOpacity="0.22" />
                </filter>
                {sheet.dots ? (
                  <pattern id={`dots-${id}`} width="8" height="8" patternUnits="userSpaceOnUse">
                    <circle cx="4" cy="4" r="1.5" fill="#6f93ff" />
                  </pattern>
                ) : null}
                {sheet.dots && !trusted ? (
                  <pattern id={`hatch-${id}`} width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width="4" height="10" fill="rgb(245 161 0 / 0.45)" />
                  </pattern>
                ) : null}
              </defs>
              <path d={sheet.path} fill={sheet.fill} filter={`url(#lift-${id}-${sheet.i})`} />
              {sheet.dots ? <path d={sheet.dots} fill={`url(#dots-${id})`} opacity="0.55" /> : null}
              {sheet.dots && !trusted ? <path d={sheet.path} fill={`url(#hatch-${id})`} /> : null}
            </svg>
          </div>
        ))}
      </div>

      <div
        ref={ladder}
        className={cx(
          "pointer-events-none absolute bottom-0 right-[calc(var(--hull-r)+8px)] w-[calc(var(--hull-w)*0.86)] sm:right-[calc(var(--hull-r)+12px)] sm:w-[calc(var(--hull-w)*0.62)]",
          AT,
        )}
        style={at((sc) => sc.top)}
        aria-hidden
      >
        {anchorLabel ? (
          <div className="absolute bottom-full left-0 mb-[84px] flex -translate-x-[6px] items-center gap-2 whitespace-nowrap rounded-sm bg-ink px-2 py-1">
            <span ref={anchorSquare} className="size-[9px] bg-rescue" />
            <span className="font-readout text-[10.5px] text-paper">{anchorLabel}</span>
          </div>
        ) : null}
        <div className="absolute inset-y-0 left-0 w-[3px] -translate-x-1/2 bg-ink/80" />
        {marks.map((mark) => (
          <div key={mark.key} className={cx("absolute inset-x-0 flex -translate-y-1/2 items-center gap-2 sm:gap-3", AT)} style={at((sc) => within(mark.value, sc))}>
            <div className={cx("h-[5px] w-[22%] shrink-0 sm:w-[28%]", mark.bar)} />
            <div className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap leading-none sm:gap-2">
              <span className="rounded-sm bg-paper/90 px-1 text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink [font-variation-settings:'wdth'_75] sm:text-[15px]">
                {size === "panel" ? (
                  mark.short
                ) : (
                  <>
                    <span className="sm:hidden">{mark.short}</span>
                    <span className="hidden sm:inline">{mark.label}</span>
                  </>
                )}
              </span>
              <span className="rounded-sm bg-paper/90 px-1 font-readout text-[11.5px] text-ink sm:text-[13px]">{formatHealth(mark.value)}</span>
            </div>
          </div>
        ))}
        {/* The disc, as on a ship's hull: a ring crossed by a bar, on the line the user set. */}
        <div
          className={cx("absolute left-[calc(-1*var(--disc,96px)-10px)] hidden w-[var(--disc,96px)] -translate-y-1/2 sm:block", AT)}
          style={at((sc) => within(levels.trigger, sc))}
        >
          <svg viewBox="0 0 120 120" className="block w-full overflow-visible">
            <circle cx="60" cy="60" r="48" fill="var(--color-paper)" stroke="var(--color-ink)" strokeWidth="9" />
            <rect x="-6" y="55" width="132" height="10" fill="var(--color-ink)" />
            <line x1="126" y1="60" x2="138" y2="60" stroke="var(--color-ink)" strokeWidth="3" strokeDasharray="4 3" />
          </svg>
          <p className="absolute left-0 top-full mt-1.5 w-full text-center [font-variation-settings:'wdth'_75]">
            <span className="rounded-sm bg-paper/90 px-1 text-[11px] font-extrabold uppercase tracking-[0.04em] text-ink">
              Your trigger
            </span>
          </p>
        </div>
      </div>

      {size === "hero" ? (
        /* A paper shoreline, so the sea ends in a cut edge rather than a ruled line. */
        <svg viewBox="0 0 1200 28" preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 bottom-[-1px] h-7 w-full" aria-hidden>
          <path d="M0 18 C 100 4, 200 4, 300 16 S 500 30, 600 16 S 800 2, 900 14 S 1100 28, 1200 12 L 1200 28 L 0 28 Z" fill="var(--color-paper)" />
        </svg>
      ) : null}

      <svg ref={rope} className="pointer-events-none absolute inset-0 size-full opacity-0 will-change-[opacity]" aria-hidden>
        <path ref={ropePath} fill="none" stroke="var(--color-ink)" strokeWidth="4" strokeLinecap="round" />
        <path ref={ropeTwist} fill="none" stroke="var(--color-rescue)" strokeWidth="2" strokeDasharray="3 6" strokeLinecap="round" />
      </svg>

      {throwLabel ? (
        <div ref={buoy} className="pointer-events-none absolute left-0 top-0 opacity-0" aria-hidden>
          <span className="absolute -left-[24px] -top-[24px] block size-[48px] drop-shadow-[0_4px_3px_rgb(11_21_51/0.35)]">
            <Mark className="size-full" />
          </span>
          <span ref={tag} className="absolute left-0 top-0 block whitespace-nowrap rounded-sm bg-ink px-2 py-1 font-readout text-[12px] text-paper">
            {throwLabel}
          </span>
        </div>
      ) : null}
      <div ref={splash} className="pointer-events-none absolute left-0 top-0" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={cx("absolute size-[9px] rounded-full opacity-0", i % 2 ? "bg-paper" : "bg-sea-light")} />
        ))}
      </div>

      <div ref={rider} className="pointer-events-none absolute inset-x-0 top-0 opacity-0 will-change-transform">
        {surface}
        <span ref={ping} className="absolute top-0 block h-[60px] w-[220px] rounded-[50%] border-2 border-paper opacity-0" />
        {/* Where the water is now, marked on the load line itself. */}
        <span className="absolute top-0 hidden h-[3px] w-[38px] -translate-y-1/2 bg-sun shadow-[0_0_0_2px_var(--color-ink)] sm:block" style={{ right: "calc(var(--hull-r) + 12px + var(--hull-w) * 0.62 - 19px)" }} />
      </div>
    </div>
  );
}
