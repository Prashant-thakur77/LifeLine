"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { formatHealth } from "../lib/format";
import { midPrice } from "../lib/hl";
import { playground } from "../lib/playground";
import { cx } from "./ui";
import { Waterline, type WaterTone } from "./Waterline";

const LEVERAGES = [5, 10, 20] as const;
const RESERVES = [50, 200, 1000] as const;
const NOTIONAL = 1000;
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;

/**
 * The price playground: pull ETH down and watch the paper sea rise, and Lifeline throw
 * the line at your trigger. Maths only, with Lifeline's real rules; it says so on the page.
 */
export function Playground() {
  const reduced = useReducedMotion();
  const [startPrice, setStartPrice] = useState(3000);
  const [live, setLive] = useState(false);
  const [drop, setDrop] = useState(4);
  const [leverage, setLeverage] = useState<(typeof LEVERAGES)[number]>(10);
  const [lifeline, setLifeline] = useState(true);
  const [trigger, setTrigger] = useState(1.5);
  const [target, setTarget] = useState(2);
  const [reserve, setReserve] = useState<(typeof RESERVES)[number]>(200);

  useEffect(() => {
    let cancelled = false;
    void midPrice("ETH").then((price) => {
      if (!cancelled && price !== null) {
        setStartPrice(price);
        setLive(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const r = useMemo(
    () =>
      playground({ startPrice, notionalUsd: NOTIONAL, leverage, dropPct: drop, lifeline, trigger, target: Math.max(target, trigger + 0.1), reserveUsd: reserve, perRescueUsd: 25, perDayUsd: 50 }),
    [startPrice, leverage, drop, lifeline, trigger, target, reserve],
  );

  // Throw the line each time a new rescue happens as the slider moves down.
  const [throwSignal, setThrowSignal] = useState(0);
  const lastCount = useRef(0);
  useEffect(() => {
    if (r.rescues.length > lastCount.current) setThrowSignal((n) => n + 1);
    lastCount.current = r.rescues.length;
  }, [r.rescues.length]);

  const health = r.liquidatedWith ? 1 : r.healthWith;
  const tone: WaterTone = r.liquidatedWith ? "liquidation" : health < trigger ? "rescue" : health < trigger + 0.3 ? "warn" : "safe";
  const label = r.liquidatedWith ? "Liquidated" : tone === "rescue" ? "Below trigger" : tone === "warn" ? "Close to the trigger" : "Safe";
  const lastRescue = r.rescues.at(-1);

  return (
    <section aria-labelledby="play-title" className="mt-28 sm:mt-32">
      <div className="grid grid-cols-1 items-end gap-6 lg:grid-cols-12">
        <h2
          id="play-title"
          className="text-[clamp(40px,5.6vw,84px)] font-extrabold uppercase leading-[0.86] tracking-[-0.01em] text-ink [font-variation-settings:'wdth'_70] lg:col-span-7"
        >
          Pull the <span className="riso text-[#ee4b12]">price</span> down
        </h2>
        <p className="max-w-md text-[16px] leading-relaxed text-body lg:col-span-5">
          A long ETH position worth {usd(NOTIONAL)}. Drag the price and watch what Lifeline does. Maths only, with Lifeline&apos;s real rules and 1Click&apos;s
          fee: no keeper, no money.
        </p>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="flex flex-col gap-6 rounded-xl border-2 border-ink bg-card p-5 sm:p-6 lg:col-span-5">
          <div>
            <label htmlFor="pg-drop" className="flex items-baseline justify-between gap-3">
              <span className="text-[14px] font-bold text-ink">ETH falls by</span>
              <span className="font-readout text-[22px] text-ink tabular-nums">{drop.toFixed(1)}%</span>
            </label>
            <input
              id="pg-drop"
              type="range"
              min={0}
              max={30}
              step={0.1}
              value={drop}
              onChange={(e) => setDrop(Number(e.target.value))}
              className="range mt-3 w-full"
              aria-valuetext={`${drop.toFixed(1)} percent, ETH at ${usd(r.price)}`}
            />
            <p className="mt-2 font-readout text-[12px] text-muted">
              {usd(startPrice)} → {usd(r.price)} {live ? "· start price live from Hyperliquid" : "· example start price"}
            </p>
          </div>

          <Choice label="Leverage" options={LEVERAGES.map((l) => ({ value: l, text: `${l}×` }))} value={leverage} onChange={setLeverage} />

          <div className="grid grid-cols-2 gap-4">
            <Slider id="pg-trigger" label="Rescue below" value={trigger} min={1.2} max={2.5} step={0.05} onChange={(v) => setTrigger(Math.min(v, target - 0.1))} />
            <Slider id="pg-target" label="Refill to" value={target} min={1.4} max={4} step={0.05} onChange={(v) => setTarget(Math.max(v, trigger + 0.1))} />
          </div>

          <Choice label="Reserve in the vault" options={RESERVES.map((v) => ({ value: v, text: usd(v) }))} value={reserve} onChange={setReserve} />

          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border-2 border-ink bg-paper px-4 py-3">
            <span className="text-[14px] font-bold text-ink">Lifeline {lifeline ? "on" : "off"}</span>
            <input type="checkbox" checked={lifeline} onChange={(e) => setLifeline(e.target.checked)} className="switch" />
          </label>
          <p className="-mt-3 text-[12.5px] leading-relaxed text-muted">Caps as the defaults: at most $25 a rescue and $50 a day. The 2-minute cooldown is left out.</p>
        </div>

        <div className="flex flex-col gap-4 lg:col-span-7">
          <div className="overflow-hidden rounded-xl border-2 border-ink">
            <Waterline
              size="panel"
              className="relative h-[360px] bg-paper sm:h-[420px]"
              health={health}
              levels={{ warn: trigger + 0.3, trigger, target: Math.max(target, trigger + 0.1) }}
              tone={tone}
              throwSignal={throwSignal}
              pingSignal={0}
              reduced={reduced}
              scaleTop={0.3}
              scaleMax={3}
              anchorLabel="Reserve"
              throwLabel={lastRescue ? `+${usd(lastRescue.landedUsd)} margin` : null}
              surface={
                <div className="absolute left-5 -translate-y-full pb-[60px] sm:left-6">
                  <p className="font-readout text-[clamp(48px,6vw,80px)] font-light leading-[0.9] tracking-[-0.05em] text-ink tabular-nums">{formatHealth(health)}</p>
                  <p className={cx("mt-2 inline-block rounded-sm px-1.5 py-0.5 font-readout text-[11px] uppercase tracking-[0.1em]", TONE_CHIP[tone])}>Health · {label}</p>
                </div>
              }
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-live="polite">
            <Outcome title="Without Lifeline" tone={r.liquidatedWithout ? "bad" : "neutral"}>
              {r.liquidatedWithout ? "Liquidated." : `Health ${formatHealth(r.healthWithout)}.`} Liquidation comes at a {r.liquidationDropPct.toFixed(1)}% drop (
              {usd(r.liquidationPrice)}).
            </Outcome>
            <Outcome title="With Lifeline" tone={!lifeline ? "neutral" : r.liquidatedWith ? "bad" : "good"}>
              {!lifeline
                ? "Switched off."
                : r.liquidatedWith
                  ? `Caps or reserve ran out: liquidated at a ${r.survivesToDropPct.toFixed(1)}% drop, after ${r.rescues.length} rescues.`
                  : `${r.rescues.length === 0 ? "No rescue needed yet." : `${r.rescues.length} rescue${r.rescues.length > 1 ? "s" : ""}, ${usd(r.spentUsd)} from the reserve.`} Survives down to a ${r.survivesToDropPct.toFixed(1)}% drop.`}
            </Outcome>
          </div>
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

function Outcome({ title, tone, children }: { title: string; tone: "good" | "bad" | "neutral"; children: ReactNode }) {
  return (
    <div className={cx("rounded-xl border-2 border-ink p-4", tone === "good" ? "bg-[#d8f5ec]" : tone === "bad" ? "bg-[#ffe1e4]" : "bg-card")}>
      <p className="font-readout text-[11px] uppercase tracking-[0.08em] text-ink">{title}</p>
      <p className="mt-1.5 text-[14.5px] leading-relaxed text-ink">{children}</p>
    </div>
  );
}

function Choice<T extends number>({ label, options, value, onChange }: { label: string; options: { value: T; text: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <fieldset>
      <legend className="text-[14px] font-bold text-ink">{label}</legend>
      <div className="mt-2 flex gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={cx(
              "flex-1 rounded-md border-2 border-ink px-3 py-2 font-readout text-[13px] transition-colors",
              value === o.value ? "bg-ink text-paper" : "bg-paper text-ink hover:bg-sun",
            )}
          >
            {o.text}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Slider({ id, label, value, min, max, step, onChange }: { id: string; label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label htmlFor={id} className="flex items-baseline justify-between gap-2">
        <span className="text-[14px] font-bold text-ink">{label}</span>
        <span className="font-readout text-[15px] text-ink tabular-nums">{formatHealth(value)}</span>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="range mt-2 w-full" />
    </div>
  );
}
