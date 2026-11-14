"use client";

import { KEEPER_POLL_INTERVAL_SEC, POLICY_DEFAULTS } from "@lifeline/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNow, usePoll } from "../hooks/usePoll";
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
import { Mark } from "./Shell";
import { ButtonLink, cx } from "./ui";
import { Waterline, type WaterTone } from "./Waterline";

const toneFor = (zone: Zone): WaterTone =>
  zone === "safe" ? "safe" : zone === "warn" ? "warn" : zone === "rescue" ? "rescue" : zone === "liquidation" ? "liquidation" : zone === "none" ? "none" : "unknown";

const toneForHealth = (health: number, levels: { warn: number; trigger: number }): WaterTone =>
  health <= 1 ? "liquidation" : health < levels.trigger ? "rescue" : health < levels.warn ? "warn" : "safe";

/** The headline as one sentence, for screen readers: the drawn lifebuoy O splits the word on screen. */
const HERO_TITLE = "Topped up before liquidation.";

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
  const lines = story ? storyLog(story, levels) : [];

  return (
    <section aria-labelledby="hero-title" className="relative -mt-8 sm:-mt-12">
      <div className="grid grid-cols-1 items-end gap-x-10 gap-y-6 pt-6 sm:pt-10 lg:grid-cols-12 lg:pt-10">
        <div className="lg:col-span-7">
          <p className="font-readout text-[12px] text-body">Hyperliquid margin protection · funded from any chain</p>
          <h1
            id="hero-title"
            aria-label={HERO_TITLE}
            data-list={tone === "rescue" || tone === "liquidation" ? "on" : "off"}
            className="listing mt-4 text-[clamp(52px,7.2vw,108px)] font-extrabold uppercase leading-[0.84] tracking-[-0.015em] text-ink [font-variation-settings:'wdth'_70]"
          >
            {/* The spaces between lines and the hidden o keep the raw text one sentence, for crawlers. */}
            <span className="kin-line">
              <span style={{ animationDelay: "40ms" }}>Topped up</span>
            </span>{" "}
            <span className="kin-line">
              <span style={{ animationDelay: "130ms" }}>before</span>
            </span>{" "}
            <span className="kin-line">
              <span className="riso text-[#ee4b12]" style={{ animationDelay: "220ms" }}>
                {/* The O is the lifebuoy itself. */}
                liquidati
                <span className="buoy-o">
                  <Mark className="size-full" />
                  <span className="sr-only">o</span>
                </span>
                n.
              </span>
            </span>
          </h1>
        </div>
        <div className="lg:col-span-5 lg:pb-3">
          <p className="max-w-[34rem] text-[17px] leading-relaxed text-body">
            Lifeline reads your account health every {KEEPER_POLL_INTERVAL_SEC} seconds. Below the line you set, a vault on NEAR sends USDC from your
            reserve to your perps balance through NEAR Intents. The vault only ever pays{" "}
            <span className="pen-under">
              your own Hyperliquid address
              <svg viewBox="0 0 300 14" preserveAspectRatio="none" aria-hidden>
                <path pathLength={1} d="M 3 9 C 60 3, 120 12, 180 6 S 270 4, 297 8" />
              </svg>
            </span>
            .
          </p>
          <div className="mt-6 flex flex-col gap-2.5 sm:flex-row sm:gap-3">
            <ButtonLink href={pageHref("/position", DEMO_USER)} variant="primary" size="lg">
              Watch the live demo
            </ButtonLink>
            <ButtonLink href="/start" variant="secondary" size="lg">
              Protect my position
            </ButtonLink>
          </div>
        </div>
      </div>

      <div className="relative mt-8 sm:mt-10">
        <Waterline
          className="relative -mx-4 h-[clamp(380px,54vh,560px)] sm:-mx-6 lg:mx-[calc(50%-50vw)]"
          health={shown}
          levels={levels}
          tone={tone}
          throwSignal={throwSignal}
          pingSignal={pingSignal}
          reduced={reduced}
          scaleTop={0.26}
          scaleMax={2.4}
          wideScale={{ top: 0.28, max: 3 }}
          anchorLabel={
            <>
              <span className="lg:hidden">Reserve</span>
              <span className="hidden lg:inline">{story?.simulated === false ? "Reserve · NEAR vault" : "Reserve · vault (simulated)"}</span>
            </>
          }
          throwLabel={story ? `+${story.amount} → ${shortMiddle(story.recipient, 6, 4)}` : null}
          surface={
            <div className="absolute left-4 -translate-y-full pb-[64px] sm:left-6 lg:left-[max(24px,calc(50vw-552px))]">
              <p className="font-readout text-[clamp(56px,7vw,112px)] font-light leading-[0.9] tracking-[-0.05em] text-ink tabular-nums">
                {shown === null ? "—" : formatHealth(shown)}
              </p>
              <p className={cx("mt-2 inline-block whitespace-nowrap rounded-sm px-1.5 py-0.5 font-readout text-[11px] uppercase tracking-[0.1em]", TONE_CHIP[tone])}>
                Health · {headline}
              </p>
            </div>
          }
        />
        <div className="relative z-10 -mt-10 ml-3 mr-3 sm:mx-6 lg:-mt-24 lg:ml-0 lg:mr-0 lg:w-[min(470px,42%)]">
          <LogTicket
            online={!(health.error && !health.data)}
            status={status}
            lines={lines}
            beat={beat}
            canReplay={story !== null}
            onReplay={play}
          />
        </div>
      </div>
    </section>
  );
}

const TONE_CHIP: Record<WaterTone, string> = {
  safe: "bg-safe text-ink",
  warn: "bg-sun text-ink",
  rescue: "bg-rescue text-ink",
  liquidation: "bg-danger text-paper",
  none: "bg-shade text-ink",
  unknown: "bg-sun text-ink",
};

const TAG_TEXT: Record<LogLine["tag"], string> = {
  READ: "text-sea-light",
  QUOTE: "text-paper",
  POLICY: "text-safe",
  VAULT: "text-rescue",
  SAFE: "text-safe",
};

const BEAT_ORDER: Beat["kind"][] = ["warn", "trigger", "throw", "restored"];

/**
 * The keeper's log of the last rescue, printed on an ink ticket. During the replay the
 * lines appear with their beats; they hold their space while hidden, so nothing shifts.
 */
function LogTicket(props: { online: boolean; status: string; lines: LogLine[]; beat: Beat | null; canReplay: boolean; onReplay: () => void }) {
  const { online, status, lines, beat, canReplay, onReplay } = props;
  const upTo = beat ? BEAT_ORDER.indexOf(beat.kind) : BEAT_ORDER.length;
  return (
    <div className="ticket relative rounded-md bg-ink px-4 pb-4 pt-3.5 font-readout text-[11.5px] text-paper shadow-[0_18px_40px_-22px_rgb(11_21_51/0.7)]">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex items-center gap-2">
          <span className={cx("size-1.5 rounded-full", online ? "bg-safe" : "bg-warn")} aria-hidden />
          {DEMO_USER}
        </span>
        <span className="rounded-sm bg-sim-ink px-1.5 py-0.5 text-paper">Simulation</span>
        {canReplay ? (
          <button type="button" onClick={onReplay} className="ml-auto py-1 text-sun underline decoration-sun/50 underline-offset-4 hover:decoration-sun">
            Replay the last rescue
          </button>
        ) : null}
      </p>
      <p className="mt-1.5 text-paper/70">{status}</p>
      {lines.length > 0 ? (
        <ol className="mt-3 space-y-1 border-t border-dashed border-paper/25 pt-3" aria-label="The keeper's log of the last rescue">
          {lines.map((line, i) => (
            <li
              key={`${line.tag}-${i}`}
              className={cx("flex gap-2.5 transition-opacity duration-300", BEAT_ORDER.indexOf(line.beat) <= upTo ? "opacity-100" : "opacity-0")}
            >
              <span className={cx("w-[68px] shrink-0", TAG_TEXT[line.tag])}>[{line.tag}]</span>
              <span className="text-paper">{line.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
