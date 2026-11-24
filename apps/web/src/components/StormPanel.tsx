"use client";

import { PORTFOLIO_LIQUIDATION_RATIO, healthAfter, storm, suggestPlan, worseDirection, type AccountRisk } from "@lifeline/hyperliquid";
import { POLICY_DEFAULTS } from "@lifeline/shared";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePoll } from "../hooks/usePoll";
import { formatHealth, formatUsd } from "../lib/format";
import { checkAccount, type AccountCheck } from "../lib/hl";
import { FLAT_FEE_USD } from "../lib/playground";
import { CHART, chartPath, chartScale, signedPct } from "../lib/storm-chart";
import { shareCardUrl, shareOnXHref } from "../lib/share";
import { Card, CopyButton, Field, Notice, Skeleton, cx, inputClass } from "./ui";

const RANGE = { down: 90, up: 150 } as const;

const MODE_LABEL = { standard: "Standard margin", unified: "Unified account", portfolio: "Portfolio margin" } as const;

/** What a storm does to this account, with and without Lifeline. Maths on a live reading, and it says so. */
export function StormPanel({ address }: { address: string }) {
  // Every dex is asked, so it's read once a minute rather than every 10 seconds.
  const reading = usePoll(`risk:${address}`, () => checkAccount(address), 60_000);
  return (
    <section aria-labelledby="storm-title" className="lg:col-span-12">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-ink bg-sea px-5 py-4 text-paper">
          <h2 id="storm-title" className="text-[clamp(28px,3.4vw,44px)] font-extrabold uppercase leading-none [font-variation-settings:'wdth'_72]">
            Storm test
          </h2>
          <p className="font-readout text-[11.5px]">{reading.data ? `${MODE_LABEL[reading.data.risk.mode]} · live reading, estimated moves` : "Live reading, estimated moves"}</p>
        </div>
        {reading.data ? (
          <Checked check={reading.data} address={address} />
        ) : reading.error ? (
          <div className="p-5">
            <Notice tone="warn" title="No storm test for this account">
              {reading.error.message}
            </Notice>
          </div>
        ) : (
          <div className="p-5">
            <Skeleton className="h-72" />
          </div>
        )}
      </Card>
    </section>
  );
}

function Checked({ check, address }: { check: AccountCheck; address: string }) {
  const { risk } = check;
  return (
    <>
      {risk.mode === "portfolio" ? (
        <div className="p-5">
          <Notice tone="warn" title={`Portfolio margin ratio ${((risk.portfolioRatio ?? 0) * 100).toFixed(1)}%`}>
            Hyperliquid liquidates this account when that ratio passes {PORTFOLIO_LIQUIDATION_RATIO * 100}%. Portfolio margin nets spot, borrowing and perps together, so Lifeline&apos;s health number
            doesn&apos;t describe it and a storm test would be a guess. Lifeline isn&apos;t built for this mode yet.
          </Notice>
        </div>
      ) : risk.covered.length === 0 ? (
        <p className="p-5 text-[15px] text-body">No cross positions{risk.unread.length > 0 ? " on the markets that could be read" : ""}, so there is nothing a top-up could protect right now.</p>
      ) : (
        <>
          <Storm risk={risk} />
          <Share address={address} />
        </>
      )}
      <Findings check={check} />
    </>
  );
}

/** A link whose preview shows this storm test. The picture is read again when the link is opened. */
function Share({ address }: { address: string }) {
  return (
    <div className="mx-5 mb-5 flex flex-wrap items-center gap-3 rounded-lg border-2 border-ink bg-sun p-4">
      <p className="min-w-0 flex-1 basis-64 text-[15px] font-bold text-ink">
        Share this storm test
        <span className="block text-[13px] font-normal">The preview shows the shortened address and both liquidation figures at the suggested reserve.</span>
      </p>
      <CopyButton value={shareCardUrl(address)} label="Copy the link" />
      <a href={shareOnXHref(address)} target="_blank" rel="noreferrer noopener" className="inline-flex h-9 items-center rounded-md border-2 border-ink bg-card px-3 text-[14px] font-bold hover:bg-paper-2">
        Post it on X
      </a>
    </div>
  );
}

function Storm({ risk }: { risk: AccountRisk }) {
  const [coin, setCoin] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const [plan, setPlan] = useState(() => suggestPlan(risk, POLICY_DEFAULTS, FLAT_FEE_USD));
  const coins = [...new Set(risk.covered.map((p) => p.coin))];
  // A position can close between two readings.
  useEffect(() => {
    if (coin !== null && !coins.includes(coin)) setCoin(null);
  }, [coin, coins]);

  const worse = worseDirection(risk, coin);
  const direction = pct === 0 ? worse : pct < 0 ? -1 : 1;
  const dying = useMemo(() => storm(risk, direction * (direction < 0 ? RANGE.down : RANGE.up), plan, coin), [risk, direction, plan, coin]);
  // Wide enough to show both deaths and the slider, in round tens.
  const reach = Math.max(Math.abs(dying.diesWithout ?? 0), Math.abs(dying.diesWith ?? 0), Math.abs(pct), 8) * 1.25;
  const toPct = direction * Math.min(Math.ceil(reach / 10) * 10, direction < 0 ? RANGE.down : RANGE.up);
  const points = useMemo(() => dying.points.filter((p) => Math.abs(p.pct) <= Math.abs(toPct)), [dying, toPct]);
  const rescues = dying.rescues.filter((r) => Math.abs(r.atPct) <= Math.abs(pct));
  const added = rescues.reduce((sum, r) => sum + r.landedUsd, 0);
  const without = healthAfter(risk, pct, coin);
  const died = (at: number | null) => at !== null && pct !== 0 && Math.abs(pct) >= Math.abs(at);
  const withLifeline = healthAfter(risk, pct, coin, added);
  const now = healthAfter(risk, 0);
  const { x, y } = chartScale(toPct);
  const number = (key: "perRescueUsd" | "reserveUsd", label: string) => (
    <Field label={label} htmlFor={`storm-${key}`}>
      <input
        id={`storm-${key}`}
        type="number"
        inputMode="decimal"
        min={0}
        className={cx(inputClass, "num")}
        value={plan[key]}
        onChange={(e) => {
          const value = Math.min(Math.max(Number(e.target.value) || 0, 0), 1e9);
          setPlan((p) => ({ ...p, [key]: value, ...(key === "reserveUsd" ? { perDayUsd: value } : {}) }));
        }}
      />
    </Field>
  );

  return (
    <div className="grid grid-cols-1 gap-6 p-5 lg:grid-cols-12">
      <div className="lg:col-span-8">
        <p className="text-[clamp(20px,2.4vw,28px)] font-bold leading-snug text-ink" aria-live="polite">
          {now <= 1
            ? "This account is at liquidation now."
            : dying.diesWithout === null
              ? `No move ${direction < 0 ? `down to −${RANGE.down}%` : `up to +${RANGE.up}%`} liquidates this account.`
              : `${coin === null ? "Everything" : coin} moving ${signedPct(dying.diesWithout)} liquidates this account.`}{" "}
          {now > 1 && dying.diesWithout !== null ? (
            <span className="text-rescue-ink">
              {dying.rescues.length === 0
                ? "With this reserve, Lifeline couldn't change that."
                : dying.diesWith === null
                  ? `With Lifeline it survives the whole range.`
                  : `With Lifeline it lasts to ${signedPct(dying.diesWith)}.`}
            </span>
          ) : null}
        </p>

        <svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} className="mt-4 w-full rounded-lg border-2 border-ink bg-paper" role="img" aria-label={`Health against price moves to ${signedPct(toPct)}, with and without Lifeline`}>
          <rect x={CHART.left} y={y(1)} width={CHART.width - CHART.left - CHART.right} height={y(0) - y(1)} fill="#ffe1e4" />
          {[1, 2, 3].map((h) => (
            <g key={h}>
              <line x1={CHART.left} x2={CHART.width - CHART.right} y1={y(h)} y2={y(h)} stroke="#0b1533" strokeOpacity={h === 1 ? 0.9 : 0.12} strokeDasharray={h === 1 ? "5 4" : undefined} />
              <text x={CHART.left - 8} y={y(h) + 4} textAnchor="end" className="text-[13px] max-sm:text-[22px]" fill="#3b4568">
                {h}
              </text>
            </g>
          ))}
          <text x={CHART.left + 8} y={y(0) - 8} className="text-[13px] max-sm:text-[24px]" fill="#c0182c">
            Liquidated below 1
          </text>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <text key={f} x={x(toPct * f)} y={CHART.height - 7} className={cx("text-[13px] max-sm:text-[24px]", f % 0.5 !== 0 && "max-sm:hidden")} textAnchor={f === 1 ? "end" : "middle"} fill="#3b4568">
              {signedPct(toPct * f)}
            </text>
          ))}
          <path d={chartPath(points, "without", toPct)} fill="none" stroke="#0b1533" strokeWidth="3" strokeDasharray="2 6" strokeLinecap="round" />
          <path d={chartPath(points, "with", toPct)} fill="none" stroke="#ff5a1f" strokeWidth="4" strokeLinejoin="round" />
          {dying.rescues.slice(0, 60).map((r, i) =>
            Math.abs(r.atPct) <= Math.abs(toPct) ? <circle key={i} cx={x(r.atPct)} cy={y(r.healthAfter)} r="6" fill="#fffcf5" stroke="#ff5a1f" strokeWidth="3.5" /> : null,
          )}
          {pct !== 0 ? <line x1={x(pct)} x2={x(pct)} y1={CHART.top} y2={CHART.height - CHART.bottom} stroke="#1d4bff" strokeWidth="2.5" /> : null}
        </svg>
        <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-body">
          <span><span className="mr-1.5 inline-block w-6 border-t-[3px] border-dotted border-ink align-middle" />Without Lifeline</span>
          <span><span className="mr-1.5 inline-block w-6 border-t-4 border-rescue align-middle" />With Lifeline</span>
          <span><span className="mr-1.5 inline-block size-3 rounded-full border-[3px] border-rescue align-middle" />A rescue</span>
        </p>

        <label htmlFor="storm-move" className="mt-5 flex items-baseline justify-between text-[15px] font-bold text-ink">
          <span>Drag the market</span>
          <output htmlFor="storm-move" className="font-readout text-[20px] font-light">{signedPct(pct)}</output>
        </label>
        <input id="storm-move" type="range" className="range w-full" min={-RANGE.down} max={RANGE.down} step={0.5} value={pct} aria-valuetext={`${signedPct(pct)}, health ${formatHealth(without)} without Lifeline`} onChange={(e) => setPct(Number(e.target.value))} />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Outcome title="Without Lifeline" dead={without <= 1 || died(dying.diesWithout)} health={without} note={pct === 0 ? "now" : `after ${signedPct(pct)}`} />
          <Outcome title="With Lifeline" dead={withLifeline <= 1 || died(dying.diesWith)} health={withLifeline} note={rescues.length === 0 ? "no rescue needed yet" : `${rescues.length} rescue${rescues.length === 1 ? "" : "s"}, ${formatUsd(rescues.reduce((s, r) => s + r.sentUsd, 0))} sent`} orange />
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:col-span-4">
        <Field label="What moves" htmlFor="storm-coin">
          <select id="storm-coin" className={inputClass} value={coin ?? ""} onChange={(e) => setCoin(e.target.value || null)}>
            <option value="">Everything together</option>
            {coins.map((c) => (
              <option key={c} value={c}>
                Only {c}
              </option>
            ))}
          </select>
        </Field>
        {number("reserveUsd", "Reserve in the vault (USD)")}
        {number("perRescueUsd", "Most per rescue (USD)")}
        <p className="text-[13px] leading-relaxed text-muted">
          Lines: rescue below {POLICY_DEFAULTS.trigger}, refill to {POLICY_DEFAULTS.target}. The amounts are sized to this account; change them. An estimate: each coin keeps its margin tier, there&apos;s no
          funding, and the market moves slowly enough for every rescue to land. A gap can be faster, and topped-up money can still be lost.
        </p>
        {risk.mode === "unified" && risk.keeperHealth !== null ? (
          <Notice tone="info" title="A unified account">
            One USDC balance stands behind all of it, and its true health is {formatHealth(risk.health)}. The keeper reads {formatHealth(risk.keeperHealth)}, from Hyperliquid&apos;s own perps balance alone,
            so it would warn and rescue earlier than needed. A top-up into a unified account hasn&apos;t been tested with real money.
          </Notice>
        ) : null}
      </div>
    </div>
  );
}

function Outcome({ title, dead, health, note, orange = false }: { title: string; dead: boolean; health: number; note: ReactNode; orange?: boolean }) {
  return (
    <div className={cx("rounded-lg border-2 border-ink p-4", dead ? "bg-danger text-paper" : orange ? "bg-[#ffe1d4]" : "bg-paper-2")}>
      <p className="text-[13px] font-semibold">{title}</p>
      <p className="font-readout text-[30px] font-light leading-tight">{dead ? "Liquidated" : Number.isFinite(health) ? formatHealth(health) : "Safe"}</p>
      <p className="text-[13px]">{note}</p>
    </div>
  );
}

/** Things worth knowing that a health number hides. */
function Findings({ check: { risk, stops, agents } }: { check: AccountCheck }) {
  const bare = stops?.filter((s) => !s.hasStop).map((s) => s.coin) ?? [];
  const expired = agents?.filter((a) => a.validUntil !== null && a.validUntil < Date.now()).length ?? 0;
  const live = agents === null ? null : agents.length - expired;
  const list = (coins: string[]) => (coins.length > 6 ? `${coins.slice(0, 6).join(", ")} and ${coins.length - 6} more` : coins.join(", "));
  const items: { title: string; body: string; tone: "warn" | "safe" | "neutral" }[] = [
    risk.uncovered.length > 0 && risk.mode !== "portfolio"
      ? { title: `${risk.uncovered.length} position${risk.uncovered.length === 1 ? "" : "s"} a top-up can't reach`, body: `${list(risk.uncovered.map((p) => p.coin))}: isolated, or on a market with its own balance.`, tone: "warn" as const }
      : risk.mode === "portfolio" || risk.unread.length > 0 || risk.covered.length === 0
        ? null
        : { title: "Every position is within reach", body: "All of them share the cross margin a top-up adds to.", tone: "safe" as const },
    stops === null
      ? { title: "Stops not read", body: "Hyperliquid didn't answer for the open orders.", tone: "neutral" as const }
      : stops.length === 0
        ? null
        : bare.length > 0
          ? { title: `${bare.length} of ${stops.length} without a stop`, body: `${list(bare)}: no reduce-only stop before liquidation for the whole position.`, tone: "warn" as const }
          : { title: "A stop on every position", body: "Each has reduce-only stops for its whole size, before liquidation.", tone: "safe" as const },
    live === null
      ? { title: "Trading keys not read", body: "Hyperliquid didn't answer.", tone: "neutral" as const }
      : { title: `${live} named key${live === 1 ? "" : "s"} can trade it`, body: "These are API wallets: they can open and close positions, and can't withdraw.", tone: live > 3 ? ("warn" as const) : ("neutral" as const) },
  ].filter((i) => i !== null);
  return (
    <>
      <ul className="grid gap-px border-t-2 border-ink bg-ink sm:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
        {items.map((item) => (
          <li key={item.title} className={cx("p-4", item.tone === "warn" ? "bg-[#fff1c9]" : item.tone === "safe" ? "bg-[#d8f5ec]" : "bg-card")}>
            <p className="text-[15px] font-bold text-ink">{item.title}</p>
            <p className="mt-1 text-[13.5px] leading-relaxed text-body">{item.body}</p>
          </li>
        ))}
      </ul>
      {risk.unread.length > 0 ? <p className="border-t-2 border-ink p-4 text-[13.5px] text-warn-ink">Couldn&apos;t read {risk.unread.join(", ")}; positions there aren&apos;t shown.</p> : null}
    </>
  );
}
