"use client";

import { useState } from "react";
import { BACKTEST, type Row } from "../lib/backtest";
import { cx } from "./ui";

type Scenario = "real" | "flash";
type Group = "leverage" | "coin";

const REPORT = "https://github.com/Prashant-thakur77/LifeLine/blob/main/research/backtest/RESULTS.md";

/** The real backtest, explorable: liquidation rates with and without Lifeline. */
export function BacktestExplorer() {
  const [scenario, setScenario] = useState<Scenario>("real");
  const [group, setGroup] = useState<Group>("leverage");
  const rows: Row[] = scenario === "flash" ? BACKTEST.flashByLeverage : group === "coin" ? BACKTEST.byCoin : BACKTEST.byLeverage;

  return (
    <section aria-labelledby="bt-title" className="mt-28 sm:mt-32">
      <div className="grid grid-cols-1 items-end gap-6 lg:grid-cols-12">
        <h2
          id="bt-title"
          className="text-[clamp(40px,5.6vw,84px)] font-extrabold uppercase leading-[0.86] tracking-[-0.01em] text-ink [font-variation-settings:'wdth'_70] lg:col-span-7"
        >
          Would it have <span className="riso text-sea">helped?</span>
        </h2>
        <p className="max-w-md text-[16px] leading-relaxed text-body lg:col-span-5">
          {BACKTEST.positions.toLocaleString("en-US")} random BTC, ETH and SOL positions on real Hyperliquid {BACKTEST.candles} candles, {BACKTEST.period}, each held{" "}
          {BACKTEST.holdDays} days. The share that got liquidated:
        </p>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="rounded-xl border-2 border-ink bg-card p-5 sm:p-7 lg:col-span-8">
          <div className="flex flex-wrap items-center gap-3">
            <Toggle
              label="Market"
              value={scenario}
              onChange={(v) => {
                setScenario(v);
                if (v === "flash") setGroup("leverage");
              }}
              options={[
                { value: "real", text: "Real candles" },
                { value: "flash", text: "Flash-crash test" },
              ]}
            />
            <Toggle
              label="Group by"
              value={group}
              onChange={setGroup}
              options={[
                { value: "leverage", text: "Leverage" },
                { value: "coin", text: "Coin", disabled: scenario === "flash" },
              ]}
            />
          </div>

          <p className="mt-4 text-[13.5px] leading-relaxed text-body">
            {scenario === "flash"
              ? "Stress test: every candle's fall is replayed as if it happened in its first minute, faster than most real markets. A bound on how much speed hurts, not a forecast."
              : "Real 4h candles. They can't show how fast the price moved inside each candle, so the flash-crash test gives the other bound."}
          </p>
          <ul className="mt-6 flex flex-col gap-5" aria-live="polite">
            {rows.map((row) => (
              <li key={`${scenario}-${row.label}`} className="grid grid-cols-[52px_1fr] items-center gap-x-4 gap-y-1.5">
                <span className={cx("row-span-2 text-[22px] font-extrabold text-ink [font-variation-settings:'wdth'_75]", row.label === "All" && "text-sea")}>{row.label}</span>
                <Bar value={row.without} tone="without" />
                <Bar value={row.lifeline} tone="with" />
              </li>
            ))}
          </ul>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 font-readout text-[12px] text-ink">
            <span className="flex items-center gap-2">
              <span className="inline-block h-3 w-6 rounded-sm border-[1.5px] border-ink bg-ink" aria-hidden /> Without protection
            </span>
            <span className="flex items-center gap-2">
              <span className="inline-block h-3 w-6 rounded-sm border-[1.5px] border-ink bg-rescue" aria-hidden /> With Lifeline, 35 s to land
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:col-span-4">
          <div className="rounded-xl border-2 border-ink bg-sun p-5">
            <p className="font-readout text-[11px] uppercase tracking-[0.08em] text-ink">{scenario === "flash" ? "Flash-crash test" : "Real candles"}</p>
            <p className="mt-2 text-[44px] font-extrabold leading-none text-ink [font-variation-settings:'wdth'_72]">
              {(rows.at(-1)!.without - rows.at(-1)!.lifeline).toFixed(1)} pts
            </p>
            <p className="mt-2 text-[14px] leading-relaxed text-ink">fewer liquidations across all positions.</p>
          </div>
          <div className="rounded-xl border-2 border-ink bg-card p-5 text-[14px] leading-relaxed text-body">
            <p className="font-bold text-ink">It buys survival, not profit.</p>
            <p className="mt-1.5">
              On average a position finished {money(BACKTEST.pnlWithout)} without Lifeline and {money(BACKTEST.pnlWith)} with it, because when a rescued position falls
              anyway, the reserve goes with it.
            </p>
            <a href={REPORT} target="_blank" rel="noreferrer noopener" className="mt-3 inline-block font-semibold text-ink underline decoration-rescue decoration-2 underline-offset-4">
              Method, caveats and charts&nbsp;↗
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;

function Bar({ value, tone }: { value: number; tone: "without" | "with" }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-5 flex-1 overflow-hidden rounded-sm border-[1.5px] border-ink bg-paper">
        <div
          className={cx("bar-grow h-full origin-left transition-transform duration-700 ease-out", tone === "without" ? "bg-ink" : "bg-rescue")}
          style={{ transform: `scaleX(${value / 70})` }}
        />
      </div>
      <span className={cx("w-[58px] shrink-0 text-right font-readout text-[14px] tabular-nums", tone === "with" ? "text-rescue-ink" : "text-ink")}>{value.toFixed(1)}%</span>
    </div>
  );
}

function Toggle<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; text: string; disabled?: boolean }[];
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded-lg border-2 border-ink bg-paper p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-md px-3 py-1.5 text-[13.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40",
            value === o.value ? "bg-ink text-paper" : "text-ink hover:bg-sun",
          )}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}
