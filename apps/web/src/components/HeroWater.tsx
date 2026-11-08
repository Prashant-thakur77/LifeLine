"use client";

import { KEEPER_POLL_INTERVAL_SEC, POLICY_DEFAULTS } from "@lifeline/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNow, usePoll } from "../hooks/usePoll";
import { useMinWidth } from "../hooks/useMinWidth";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { DEMO_USER } from "../lib/config";
import { config } from "../lib/env";
import { formatHealth, shortMiddle, timeAgo } from "../lib/format";
import { SIM_STALE_AFTER_MS, classifyHealth, type Zone } from "../lib/gauge";
import { keeper } from "../lib/keeper";
import { pageHref } from "../lib/links";
import { lastRescueStory, storyLog, type LogLine } from "../lib/replay";
import { simRestCountdown } from "../lib/sim";
import { replayBeats, type Beat } from "../lib/waterline";
import { ButtonLink, cx } from "./ui";
import { Waterline, type WaterTone } from "./Waterline";

const toneFor = (zone: Zone): WaterTone =>
  zone === "safe" ? "safe" : zone === "warn" ? "warn" : zone === "rescue" ? "rescue" : zone === "liquidation" ? "liquidation" : zone === "none" ? "none" : "unknown";

const toneForHealth = (health: number, levels: { warn: number; trigger: number }): WaterTone =>
  health <= 1 ? "liquidation" : health < levels.trigger ? "rescue" : health < levels.warn ? "warn" : "safe";

const BEAT_LABEL: Record<Beat["kind"], string> = {
  warn: "Below warn",
  trigger: "Below trigger",
  throw: "Rescue sent",
  restored: "Refilled",
};

const clock = (iso: string) => new Date(iso).toISOString().slice(11, 19);

export function HeroWater() {
  const base = config.simKeeperApiUrl;
  const reduced = useReducedMotion();
  const health = usePoll(`hero-health:${base}`, () => keeper.health(base, DEMO_USER), KEEPER_POLL_INTERVAL_SEC * 1000);
  const info = usePoll(`hero-info:${base}`, () => keeper.info(base), 60_000);
  const audit = usePoll(`hero-audit:${base}`, () => keeper.audit(base, DEMO_USER, 12), 15_000);
  const now = useNow(1000);

  const reading = health.data ? classifyHealth(health.data, now, SIM_STALE_AFTER_MS, health.updatedAt) : null;
  const levels = health.data?.policy ?? POLICY_DEFAULTS;
  const rest = simRestCountdown(info.data?.nextAlarmAt, now);
  const story = useMemo(() => (audit.data ? lastRescueStory(audit.data) : null), [audit.data]);

  // The replay: recorded beats of the last rescue, on a compressed clock.
  const [beat, setBeat] = useState<Beat | null>(null);
  const [throwSignal, setThrowSignal] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const played = useRef<string | null>(null);

  const play = useCallback(() => {
    if (!story) return;
    for (const t of timers.current) clearTimeout(t);
    const beats = replayBeats(story);
    timers.current = beats.map((b) =>
      setTimeout(() => {
        setBeat(b);
        if (b.kind === "throw") setThrowSignal((n) => n + 1);
      }, b.atMs),
    );
    const end = beats.at(-1)!.atMs + 1800;
    timers.current.push(setTimeout(() => setBeat(null), end));
    played.current = story.restored.at;
  }, [story]);

  // Play once when the story first arrives, and again when a newer rescue lands while the page is open.
  useEffect(() => {
    if (!story || played.current === story.restored.at) return;
    if (reduced) {
      played.current = story.restored.at;
      return;
    }
    play();
  }, [story, reduced, play]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const [pingSignal, setPingSignal] = useState(0);
  useEffect(() => {
    if (health.updatedAt !== undefined) setPingSignal((n) => n + 1);
  }, [health.updatedAt]);

  const trusted = reading !== null && reading.health !== null && reading.zone !== "unknown" && reading.zone !== "stale";
  const shown = beat ? beat.health : trusted ? reading!.health : null;
  const tone: WaterTone = beat ? (beat.kind === "restored" ? toneForHealth(beat.health, levels) : beat.kind === "warn" ? "warn" : "rescue") : reading ? toneFor(reading.zone) : "unknown";
  const headline = beat ? BEAT_LABEL[beat.kind] : reading?.headline ?? "Reading";

  const status = beat && story
    ? `Replay of the last rescue, ${timeAgo(story.restored.at, now)}, at ${clock(beat.at)} UTC`
    : `${health.updatedAt ? `Read ${timeAgo(new Date(health.updatedAt).toISOString(), now)}` : "Reading…"}${rest ? ` · next price drop in ${rest}` : ""}${story ? ` · last rescue ${timeAgo(story.restored.at, now)}` : ""}`;
  const panel = (
    <InstrumentPanel
      online={!(health.error && !health.data)}
      status={status}
      lines={story ? storyLog(story, levels) : []}
      beat={beat}
      canReplay={story !== null}
      onReplay={play}
    />
  );

  // The text column's right edge, as a fraction of the width: the water's surface line stays quiet behind it.
  const wide = useMinWidth(1024);
  const textColumn = useRef<HTMLDivElement>(null);
  const [quietLeft, setQuietLeft] = useState(0);
  useEffect(() => {
    const el = textColumn.current;
    if (!el || !wide) {
      setQuietLeft(0);
      return;
    }
    const measure = () => setQuietLeft(Math.min(0.7, (el.getBoundingClientRect().right + 24) / window.innerWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [wide]);

  return (
    <section aria-labelledby="hero-title" className="relative -mt-8 sm:-mt-12">
      <div className="relative flex flex-col lg:block lg:h-[calc(100svh-56px)] lg:max-h-[940px] lg:min-h-[700px]">
        <Waterline
          className="relative order-2 -mx-4 mt-6 h-[42svh] max-h-[420px] min-h-[290px] sm:-mx-6 lg:absolute lg:inset-0 lg:mx-[calc(50%-50vw)] lg:mt-0 lg:h-auto lg:max-h-none lg:min-h-0"
          health={shown}
          levels={levels}
          tone={tone}
          throwSignal={throwSignal}
          pingSignal={pingSignal}
          reduced={reduced}
          scaleTop={wide ? 0.14 : 0.1}
          scaleMax={wide ? 4 : 2.4}
          quietLeft={quietLeft}
          anchorLabel={wide ? (story?.simulated === false ? "Reserve · NEAR vault" : "Reserve · vault (simulated)") : "Reserve"}
          throwLabel={story ? `+${story.amount} → ${shortMiddle(story.recipient, 6, 4)}` : null}
          surface={
            <div className="absolute left-4 -translate-y-full pb-3 sm:left-6 lg:left-auto lg:right-[calc(var(--ladder-r)+var(--ladder-w)+var(--disc-w)+46px)] lg:text-right">
              <p className="font-readout text-[clamp(52px,6.4vw,104px)] font-light leading-[0.9] tracking-[-0.04em] text-paper tabular-nums">
                {shown === null ? "—" : formatHealth(shown)}
              </p>
              <p className={cx("mt-2 whitespace-nowrap font-readout text-[11px] uppercase tracking-[0.12em]", TONE_TEXT[tone])}>Health · {headline}</p>
            </div>
          }
        />

        <div ref={textColumn} className="relative z-10 order-1 pt-6 sm:pt-10 lg:max-w-[540px] lg:pt-[clamp(40px,7vh,88px)]">
          <p className="font-readout text-[12px] text-mist-300">Hyperliquid margin protection · funded from any chain</p>
          <h1
            id="hero-title"
            className="hero-title mt-5 font-stencil text-[clamp(46px,6.6vw,104px)] font-bold uppercase leading-[0.86] tracking-[-0.01em] text-paper [font-stretch:78%]"
          >
            Topped up before liquidation.
          </h1>
        </div>

        <div className="relative z-10 order-3 flex flex-col lg:max-w-[540px]">
          <p className="order-2 mt-6 max-w-[33rem] text-[16.5px] leading-relaxed text-mist-200 sm:text-[17px] lg:order-1 lg:max-w-[30rem]">
            Lifeline reads your account health every {KEEPER_POLL_INTERVAL_SEC} seconds. Below the line you set, a vault on NEAR sends USDC from your
            reserve to your perps balance through NEAR Intents. The vault only ever pays your own Hyperliquid address.
          </p>
          <div className="order-1 mt-5 flex flex-col gap-2.5 sm:flex-row sm:gap-3 lg:order-2 lg:mt-8">
            <ButtonLink href={pageHref("/position", DEMO_USER)} variant="primary" size="lg">
              Watch the live demo
            </ButtonLink>
            <ButtonLink href="/start" variant="secondary" size="lg">
              Protect my position
            </ButtonLink>
          </div>
        </div>

        <div className="relative z-10 order-4 pt-8 lg:absolute lg:bottom-0 lg:left-0 lg:max-w-[540px] lg:pb-6 lg:pt-8">{panel}</div>
      </div>
    </section>
  );
}

const TAG_TEXT: Record<LogLine["tag"], string> = {
  READ: "text-mist-200",
  QUOTE: "text-paper",
  POLICY: "text-safe",
  VAULT: "text-rescue",
  SAFE: "text-safe",
};

const BEAT_ORDER: Beat["kind"][] = ["warn", "trigger", "throw", "restored"];

/**
 * The status line and the keeper's log of the last rescue. During the replay the lines
 * appear with their beats; they hold their space while hidden, so nothing shifts.
 */
function InstrumentPanel(props: {
  online: boolean;
  status: string;
  lines: LogLine[];
  beat: Beat | null;
  canReplay: boolean;
  onReplay: () => void;
}) {
  const { online, status, lines, beat, canReplay, onReplay } = props;
  const upTo = beat ? BEAT_ORDER.indexOf(beat.kind) : BEAT_ORDER.length;
  return (
    <div className="font-readout text-[11.5px] text-mist-200">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-2 text-paper">
          <span className={cx("size-1.5 rounded-full", online ? "bg-safe" : "bg-warn")} aria-hidden />
          {DEMO_USER}
        </span>
        <span className="rounded-sm border border-sim/50 px-1.5 py-0.5 text-sim">Simulation</span>
        <span>{status}</span>
        {canReplay ? (
          <button type="button" onClick={onReplay} className="py-1 text-paper underline decoration-mist-400 underline-offset-4 hover:decoration-rescue">
            Replay the last rescue
          </button>
        ) : null}
      </p>
      {lines.length > 0 ? (
        <ol className="mt-3 space-y-1" aria-label="The keeper's log of the last rescue">
          {lines.map((line, i) => (
            <li
              key={`${line.tag}-${i}`}
              className={cx(
                "flex gap-2.5 transition-opacity duration-300",
                BEAT_ORDER.indexOf(line.beat) <= upTo ? "opacity-100" : "opacity-0",
                i < 2 && line.tag === "READ" && "log-trim",
              )}
            >
              <span className={cx("w-[68px] shrink-0", TAG_TEXT[line.tag])}>[{line.tag}]</span>
              <span className="text-mist-100">{line.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

const TONE_TEXT: Record<WaterTone, string> = {
  safe: "text-safe",
  warn: "text-warn",
  rescue: "text-rescue",
  liquidation: "text-danger",
  none: "text-mist-300",
  unknown: "text-warn",
};
