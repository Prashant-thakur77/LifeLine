"use client";

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { KEEPER_POLL_INTERVAL_SEC } from "@lifeline/shared";
import { usePoll, useNow } from "../hooks/usePoll";
import { config } from "../lib/env";
import { formatHealth, formatLatency, formatUsd, timeAgo } from "../lib/format";
import { keeper } from "../lib/keeper";
import { OUTCOME_LABEL, eventTitle, groupRecords, type LedgerEvent } from "../lib/records";
import { FundScene, PolicyScene, RescueScene, WatchScene } from "./art/Scenes";
import { BacktestExplorer } from "./BacktestExplorer";
import { HeroWater } from "./HeroWater";
import { RefusalReceipt } from "./RefusalReceipt";
import { Playground } from "./Playground";
import { ButtonLink, Skeleton, cx } from "./ui";
import { DEMO_USER } from "../lib/config";
import { pageHref } from "../lib/links";
import { Mark } from "./Shell";

export function Landing() {
  return (
    <div className="flex flex-col">
      <HeroWater />
      <Readouts />
      <Playground />
      <HowItWorks />
      <BacktestExplorer />
      <Safety />
      <Certificate />
      <NextStep />
    </div>
  );
}

function SectionTitle({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return (
    <h2
      id={id}
      className={cx("text-[clamp(40px,5.6vw,84px)] font-extrabold uppercase leading-[0.86] tracking-[-0.01em] [font-variation-settings:'wdth'_70]", className)}
    >
      {children}
    </h2>
  );
}

/** The keeper's numbers, printed on a sunshine band. */
function Readouts() {
  const base = config.keeperApiUrl;
  const info = usePoll(`info:${base}`, () => keeper.info(base), null);
  const stats = usePoll(`stats:${base}`, () => keeper.stats(base), 30_000);
  const simulation = info.data?.mode === "sim";

  const tiles = stats.data
    ? [
        { label: "Rescues", value: String(stats.data.totalRescues) },
        { label: "USD rescued", value: formatUsd(stats.data.totalUsdRescued) },
        { label: "Blocked by policy", value: String(stats.data.blockedCount) },
        { label: "Median rescue", value: formatLatency(stats.data.latencyP50Ms) },
        { label: "95th percentile", value: formatLatency(stats.data.latencyP95Ms) },
      ]
    : null;

  return (
    <section aria-labelledby="stats-title" className="relative -mx-4 mt-24 bg-sun px-4 py-14 sm:-mx-6 sm:px-6 sm:py-16 lg:mx-[calc(50%-50vw)] lg:px-[max(24px,calc(50vw-552px))]">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionTitle id="stats-title" className="text-ink">
          The keeper so far
        </SectionTitle>
        <p className="max-w-md font-readout text-[12px] leading-relaxed text-ink">
          Live from {new URL(base).host}.
          {simulation ? <span className="ml-1 rounded-sm bg-ink px-1.5 py-0.5 text-paper">Simulation</span> : null}
          {simulation ? " Its rescue times aren't real settlement times." : null}
        </p>
      </div>
      <dl className="mt-10 grid grid-cols-2 border-y-2 border-ink sm:grid-cols-5" aria-busy={tiles ? undefined : true}>
        {tiles
          ? tiles.map((tile, i) => (
              <div
                key={tile.label}
                className={cx(
                  "py-6 pr-4 sm:py-8",
                  i > 0 && "sm:border-l-2 sm:border-ink sm:pl-5",
                  i % 2 === 1 && "border-l-2 border-ink pl-4 sm:pl-5",
                  i === 4 && "col-span-2 border-t-2 border-ink sm:col-span-1 sm:border-t-0",
                )}
              >
                <dt className="font-readout text-[11px] uppercase tracking-[0.08em] text-ink">{tile.label}</dt>
                <dd className="mt-3 font-readout text-[clamp(26px,2.8vw,44px)] font-light leading-none tracking-[-0.04em] text-ink tabular-nums [font-variation-settings:'wdth'_80]">
                  {tile.value}
                </dd>
              </div>
            ))
          : stats.error
            ? (
                <div className="col-span-2 py-6 sm:col-span-5">
                  <dt className="sr-only">Keeper stats</dt>
                  <dd className="text-[14px] text-danger-ink">{stats.error.message}</dd>
                </div>
              )
            : Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="py-6 pr-4">
                  <dt className="sr-only">Loading</dt>
                  <dd>
                    <Skeleton className="h-[58px] bg-ink/10" />
                  </dd>
                </div>
              ))}
      </dl>
      <LiveFeed />
    </section>
  );
}

const OUTCOME_CHIP: Record<LedgerEvent["outcome"], string> = {
  done: "bg-safe text-ink",
  failed: "bg-danger text-paper",
  "in-progress": "bg-sea text-paper",
  blocked: "bg-ink text-paper",
  warn: "bg-paper text-ink",
};

/** The keeper's latest entries on the public ledger, newest first; new ones slide in. */
function LiveFeed() {
  const base = config.simKeeperApiUrl;
  const ledger = usePoll(`feed:${base}`, () => keeper.ledger(base, 40), 15_000);
  const now = useNow(5_000);
  const events = useMemo(() => groupRecords(ledger.data ?? []).slice(0, 5), [ledger.data]);
  if (events.length === 0) return null;
  return (
    <div className="mt-10">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="flex items-center gap-2.5 text-[18px] font-bold text-ink">
          <span className="relative flex size-2.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-ink/40" aria-hidden />
            <span className="relative size-2.5 rounded-full bg-ink" aria-hidden />
          </span>
          Latest on the ledger
        </h3>
        <Link href="/ledger" className="text-[14px] font-semibold text-ink underline decoration-2 underline-offset-4 hover:decoration-rescue">
          All of it&nbsp;→
        </Link>
      </div>
      <ol className="mt-4 divide-y-2 divide-ink/15 border-y-2 border-ink" aria-live="polite">
        {events.map((event) => (
          <li key={event.key} className="feed-in grid grid-cols-[auto_1fr_auto] items-baseline gap-x-4 gap-y-1 py-3 sm:grid-cols-[96px_120px_1fr_auto]">
            <span className="font-readout text-[12px] text-ink sm:order-none">{timeAgo(event.at, now)}</span>
            <span className={cx("w-fit rounded-sm border-[1.5px] border-ink px-1.5 py-0.5 font-readout text-[10.5px] uppercase tracking-[0.06em]", OUTCOME_CHIP[event.outcome])}>
              {OUTCOME_LABEL[event.outcome]}
            </span>
            <span className="col-span-3 text-[15px] font-semibold text-ink sm:col-span-1">{eventTitle(event)}</span>
            <span className="hidden font-readout text-[12px] text-ink sm:block">
              {event.healthBefore !== null ? `health ${formatHealth(event.healthBefore)}` : ""}
              {event.healthAfter !== null ? ` → ${formatHealth(event.healthAfter)}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const STEPS = [
  { title: "Fund a reserve from any chain", body: "Pay with what you hold. 1Click swaps it into USDC on NEAR, in your own account, and one click moves it into the Lifeline vault.", Art: FundScene, tint: "bg-[#fff1c9]" },
  { title: "Paint your lines on the hull", body: "When to warn you, when to rescue and what health to refill to, plus caps per rescue and per day and a cooldown. The vault stores them.", Art: PolicyScene, tint: "bg-[#ffe1d4]" },
  { title: `A reading every ${KEEPER_POLL_INTERVAL_SEC} seconds`, body: "The keeper reads health from Hyperliquid: cross account value divided by maintenance margin. Liquidation comes at 1.0.", Art: WatchScene, tint: "bg-[#e3ebff]" },
  { title: "A line thrown, within your rules", body: "Below your trigger it gets a signed 1Click quote to your perps balance and asks the vault to pay it. The vault checks every rule again, on chain.", Art: RescueScene, tint: "bg-[#d8f5ec]" },
];

/** How a rescue happens: four paper scenes, in order. */
function HowItWorks() {
  return (
    <section aria-labelledby="how-title" className="how mt-28 sm:mt-32">
      <div className="how-stage">
        <div className="grid grid-cols-1 items-end gap-6 lg:grid-cols-12">
          <SectionTitle id="how-title" className="text-ink lg:col-span-7">
            How a rescue <span className="riso text-sea">happens</span>
          </SectionTitle>
          <p className="max-w-md text-[16px] leading-relaxed text-body lg:col-span-5">
            From the money you hold to the margin that saves your position, in four steps. The last two run on their own, every {KEEPER_POLL_INTERVAL_SEC}{" "}
            seconds.
          </p>
        </div>
        <ol className="how-track mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ title, body, Art, tint }, i) => (
            <li key={title} className="how-card flex flex-col overflow-hidden rounded-xl border-2 border-ink bg-card">
              <div className={cx("border-b-2 border-ink", tint)}>
                <Art />
              </div>
              <div className="flex flex-1 flex-col p-5">
                <p className="font-readout text-[12px] text-rescue-ink">
                  Step {i + 1} of {STEPS.length}
                </p>
                <h3 className="mt-1.5 text-[20px] font-bold leading-snug text-ink">{title}</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-body">{body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="how-rope mt-10 hidden h-[6px] overflow-hidden rounded-full bg-ink/10" aria-hidden>
          <div className="how-rope-fill h-full origin-left bg-[repeating-linear-gradient(90deg,var(--color-ink)_0_10px,var(--color-rescue)_10px_16px)]" />
        </div>
      </div>
    </section>
  );
}

const GUARANTEES = [
  {
    title: "It only pays your Hyperliquid address",
    body: "The vault reads where the money goes from 1Click's signed quote: the deposit address, your Hyperliquid address, the amount and the refund account. Anything else is refused.",
    codes: ["BAD_QUOTE", "RECIPIENT_MISMATCH"],
  },
  { title: "It can't pass your caps", body: "Per rescue, per 24 hours and a cooldown between rescues, enforced by the contract, not by the keeper's good behaviour.", codes: ["OVER_PER_RESCUE", "OVER_DAILY", "COOLDOWN"] },
  { title: "Its key does one thing", body: "The keeper holds a function-call key that can call the vault's rescue method and nothing else. It can't withdraw, transfer or change a policy.", codes: ["NOT_KEEPER"] },
  { title: "You stay in charge", body: "Pause at once, with no deposit to attach. Unpause and withdraw any time, with a confirmation in your wallet.", codes: ["PAUSED"] },
];

/** What a hacked keeper can't do: a ship's safety notice, with the real refusal pinned beside it. */
function Safety() {
  return (
    <section aria-labelledby="safety-title" className="mt-24 sm:mt-28">
      <div className="overflow-hidden rounded-2xl border-2 border-ink bg-sea text-paper">
        <div className="grid grid-cols-1 gap-10 p-6 sm:p-10 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <p className="font-readout text-[11px] uppercase tracking-[0.12em] text-paper">Safety notice · vault contract on NEAR</p>
            <SectionTitle id="safety-title" className="mt-4 text-paper">
              What a hacked keeper can&apos;t do
            </SectionTitle>
            <p className="mt-5 max-w-sm text-[16px] leading-relaxed text-paper/90">
              The rules live in the vault contract, where a hacked keeper still can&apos;t break them. Each code below is what the contract answers when it refuses.
            </p>
            <RefusalReceipt className="mt-8 -rotate-1" />
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href="/attack" variant="primary" size="lg">
                Try to rob it <span aria-hidden>→</span>
              </ButtonLink>
              <ButtonLink href="/verify" variant="secondary" size="lg">
                Check every claim yourself
              </ButtonLink>
            </div>
          </div>
          <dl className="lg:col-span-7">
            {GUARANTEES.map((g) => (
              <div key={g.title} className="grid grid-cols-1 gap-3 border-b-2 border-paper/25 py-6 first:pt-0 last:border-b-0 sm:grid-cols-12 sm:gap-6">
                <dt className="text-[20px] font-bold leading-snug sm:col-span-5">{g.title}</dt>
                <dd className="sm:col-span-7">
                  <p className="text-[15px] leading-relaxed text-paper/90">{g.body}</p>
                  <p className="mt-3 flex flex-wrap gap-2">
                    {g.codes.map((code) => (
                      <code key={code} className="rounded-sm bg-paper px-1.5 py-0.5 font-readout text-[11.5px] text-ink">
                        {code}
                      </code>
                    ))}
                  </p>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <Link href="/ledger" className="mt-6 inline-block text-[15px] font-semibold text-ink underline decoration-rescue decoration-2 underline-offset-4 hover:text-rescue-ink">
        Read the public ledger&nbsp;→
      </Link>
    </section>
  );
}

/** The attestation result, as an inspection certificate. */
function Certificate() {
  const base = config.keeperApiUrl;
  const attestation = usePoll(`attestation:${base}`, () => keeper.attestation(base), 120_000);
  const now = useNow(10_000);
  const data = attestation.data;
  const stamp = data?.status === "verified" ? "Verified" : data?.status === "failed" ? "Failed" : "Not checked";

  return (
    <section aria-labelledby="cert-title" className="mt-16 rounded-2xl border-2 border-ink bg-[#d8f5ec] sm:mt-20">
      <div className="grid grid-cols-1 gap-8 p-6 sm:p-8 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <p className="font-readout text-[11px] uppercase tracking-[0.1em] text-safe-ink">Inspection · NEAR AI Cloud</p>
          <h2 id="cert-title" className="mt-3 text-[clamp(28px,3.2vw,44px)] font-extrabold uppercase leading-[0.9] text-ink [font-variation-settings:'wdth'_72]">
            The explainer&apos;s hardware, checked
          </h2>
          <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-body">
            Every decision gets a plain-language explanation written from its record, and a sentence from a private model on NEAR AI Cloud, kept only when
            its signature checks out against the enclave&apos;s attested key. The keeper checks, with a fresh nonce, that the model&apos;s hardware is a
            genuine secure enclave, through NVIDIA and Intel.
          </p>
        </div>
        <div className="relative lg:col-span-6">
          <div
            className={cx(
              "absolute right-0 top-0 rounded-sm border-2 px-3 py-1 text-[18px] font-extrabold uppercase tracking-[0.04em] [font-variation-settings:'wdth'_72]",
              data?.status === "verified" ? "border-ink bg-safe text-ink" : data?.status === "failed" ? "border-danger-ink text-danger-ink" : "border-line-strong text-muted",
            )}
            aria-hidden
          >
            {data ? stamp : "…"}
          </div>
          <p className="sr-only">Attestation status: {data ? stamp : "loading"}.</p>
          {data && data.checks.length > 0 ? (
            <ul className="mt-14 divide-y-2 divide-ink/10 border-y-2 border-ink/15">
              {data.checks.map((check) => (
                <li key={check.name} className="flex items-baseline justify-between gap-4 py-2.5 text-[14px]">
                  <span className="text-ink">
                    {check.name}
                    {check.detail ? <span className="text-muted"> · {check.detail}</span> : null}
                  </span>
                  <span className={cx("font-readout text-[12px]", check.passed ? "text-safe-ink" : "text-danger-ink")}>{check.passed ? "pass" : "fail"}</span>
                </li>
              ))}
            </ul>
          ) : data ? (
            <p className="mt-14 text-[14px] text-body">No check has run yet, or NEAR AI Cloud didn&apos;t answer.</p>
          ) : attestation.error ? (
            <p className="mt-14 text-[14px] text-danger-ink">{attestation.error.message}</p>
          ) : (
            <div className="mt-14 h-40 animate-pulse rounded-md bg-ink/5" aria-hidden />
          )}
          {data ? (
            <p className="mt-4 font-readout text-[11.5px] text-muted">
              {data.model ?? "model unknown"}
              {data.checkedAt ? ` · checked ${timeAgo(data.checkedAt, now)}` : ""}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** One clear next step, then the footer. */
function NextStep() {
  return (
    <section aria-labelledby="next-title" className="mt-16 overflow-hidden rounded-2xl border-2 border-ink bg-rescue sm:mt-20">
      <div className="relative flex flex-col gap-8 p-6 sm:p-10 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 id="next-title" className="text-[clamp(40px,6vw,88px)] font-extrabold uppercase leading-[0.86] text-ink [font-variation-settings:'wdth'_70]">
            Watch a rescue,
            <br />
            live.
          </h2>
          <p className="mt-4 max-w-md text-[16px] leading-relaxed text-ink">No wallet, no funds. The demo account drops below its trigger every 15 minutes, and the keeper tops it up.</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <ButtonLink href={pageHref("/position", DEMO_USER)} variant="secondary" size="lg">
            Open the live demo
          </ButtonLink>
          <ButtonLink href="/start" variant="secondary" size="lg" className="bg-ink text-paper hover:bg-ink-2">
            Protect my position
          </ButtonLink>
        </div>
        <Mark quarters="#0b1533" className="pointer-events-none absolute -right-10 -top-20 hidden size-56 sm:block lg:size-72" />
      </div>
    </section>
  );
}
