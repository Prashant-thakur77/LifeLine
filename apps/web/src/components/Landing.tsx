"use client";

import Link from "next/link";
import { KEEPER_POLL_INTERVAL_SEC, POLICY_DEFAULTS } from "@lifeline/shared";
import { usePoll, useNow } from "../hooks/usePoll";
import { DEMO_USER } from "../lib/config";
import { config } from "../lib/env";
import { formatLatency, formatUsd, timeAgo } from "../lib/format";
import { SIM_STALE_AFTER_MS, classifyHealth } from "../lib/gauge";
import { keeper } from "../lib/keeper";
import { pageHref } from "../lib/links";
import { simRestCountdown } from "../lib/sim";
import { HealthGauge } from "./HealthGauge";
import { Badge, ButtonLink, Card, Skeleton, cx } from "./ui";

export function Landing() {
  return (
    <div className="flex flex-col gap-20 sm:gap-24">
      <Hero />
      <StatsSection />
      <HowItWorks />
      <Safety />
    </div>
  );
}

function Hero() {
  return (
    <section className="grid grid-cols-1 items-center gap-10 lg:grid-cols-12">
      <div className="animate-rise lg:col-span-7">
        <p className="mb-4 text-[12px] font-medium uppercase tracking-[0.18em] text-rescue">Margin protection for Hyperliquid</p>
        <h1 className="font-display text-[40px] leading-[1.04] font-medium tracking-[-0.02em] text-paper sm:text-[58px]">
          Auto top-up for onchain perps, funded from any chain.
        </h1>
        <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-mist-300">
          Lifeline watches your Hyperliquid margin every {KEEPER_POLL_INTERVAL_SEC} seconds. When health falls below the line you set, it sends USDC from
          your reserve on NEAR to your perps balance through NEAR Intents, before liquidation gets close.
        </p>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-mist-400">
          The money sits in a vault that only ever pays your own Hyperliquid address, within caps you choose. Fund it from Ethereum, Solana, Base, Bitcoin
          or dozens of other chains.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <ButtonLink href={pageHref("/position", DEMO_USER)} variant="primary" size="lg">
            Watch the live demo
          </ButtonLink>
          <ButtonLink href="/start" variant="secondary" size="lg">
            Protect my position
          </ButtonLink>
        </div>
        <p className="mt-3 text-[13px] text-mist-400">The demo needs no wallet and no funds.</p>
      </div>
      <div className="lg:col-span-5">
        <LiveDemo />
      </div>
    </section>
  );
}

function LiveDemo() {
  const base = config.simKeeperApiUrl;
  const health = usePoll(`landing-health:${base}`, () => keeper.health(base, DEMO_USER), KEEPER_POLL_INTERVAL_SEC * 1000);
  const info = usePoll(`landing-info:${base}`, () => keeper.info(base), 60_000);
  const now = useNow(1000);
  const reading = health.data ? classifyHealth(health.data, now, SIM_STALE_AFTER_MS, health.updatedAt) : null;
  const levels = health.data?.policy ?? POLICY_DEFAULTS;
  const rest = simRestCountdown(info.data?.nextAlarmAt, now);

  return (
    <Card className="relative overflow-hidden p-5 sm:p-6">
      <div className="pointer-events-none absolute -right-24 -top-24 size-64 rounded-full bg-sim/10 blur-3xl" aria-hidden />
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={cx("size-2 rounded-full", health.error && !health.data ? "bg-warn" : "bg-safe animate-pulse-soft")} aria-hidden />
          <span className="text-[13px] font-medium text-mist-200">{DEMO_USER}, live</span>
        </div>
        <Badge tone="sim">Simulation</Badge>
      </div>
      <div className="mt-2">
        {health.loading ? <Skeleton className="mx-auto aspect-[320/262] w-full max-w-[300px]" /> : <HealthGauge reading={reading} levels={levels} compact />}
      </div>
      <p className="min-h-[42px] text-center text-[13.5px] leading-relaxed text-mist-300">
        {health.error && !health.data
          ? "The sim keeper isn't answering right now. It may be restarting."
          : rest
            ? `Resting between price drops. The next drop starts in ${rest}; watch the keeper rescue it.`
            : reading
              ? `${reading.detail}`
              : " "}
      </p>
      <Link href={pageHref("/position", DEMO_USER)} className="mt-3 block text-center text-[14px] font-medium text-paper underline decoration-ink-500 underline-offset-4 hover:decoration-rescue">
        Open the full demo →
      </Link>
    </Card>
  );
}

function StatsSection() {
  const base = config.keeperApiUrl;
  const info = usePoll(`info:${base}`, () => keeper.info(base), null);
  const stats = usePoll(`stats:${base}`, () => keeper.stats(base), 30_000);
  const attestation = usePoll(`attestation:${base}`, () => keeper.attestation(base), 120_000);
  const simulation = info.data?.mode === "sim";
  const now = useNow(10_000);

  const tiles = stats.data
    ? [
        { label: "Rescues", value: String(stats.data.totalRescues) },
        { label: "USD rescued", value: formatUsd(stats.data.totalUsdRescued) },
        { label: "Blocked by policy", value: String(stats.data.blockedCount) },
        { label: "Median rescue time", value: formatLatency(stats.data.latencyP50Ms) },
        { label: "95th percentile", value: formatLatency(stats.data.latencyP95Ms) },
      ]
    : null;

  return (
    <section aria-labelledby="stats-title">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="stats-title" className="font-display text-[26px] text-paper">The keeper so far</h2>
          <p className="mt-1 text-[14px] text-mist-400">
            Live from {new URL(base).host}
            {simulation ? ". This keeper runs the simulation, so its rescue times aren't real settlement times." : "."}
          </p>
        </div>
        {simulation ? <Badge tone="sim">Simulation</Badge> : null}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {tiles
          ? tiles.map((tile) => (
              <div key={tile.label} className="rounded-2xl border border-ink-600/70 bg-ink-800/70 px-4 py-4">
                <p className="text-[12px] text-mist-400">{tile.label}</p>
                <p className="num mt-1.5 text-[24px] text-paper">{tile.value}</p>
              </div>
            ))
          : stats.error
            ? (
                <p className="col-span-2 text-[14px] text-[#ff8a98] sm:col-span-5">{stats.error.message}</p>
              )
            : Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[88px] rounded-2xl" />)}
      </div>

      <Card className="mt-4 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xl">
            <h3 className="text-[15px] font-semibold text-paper">Explanations from attested hardware</h3>
            <p className="mt-1 text-[14px] leading-relaxed text-mist-300">
              Every decision gets a plain-language explanation. The facts come from the record itself, and a private model on NEAR AI Cloud adds a
              sentence when the keeper has a NEAR AI key. The keeper checks, with a fresh nonce, that the model runs in a secure enclave, verified
              through NVIDIA and Intel.
            </p>
          </div>
          {attestation.data ? (
            <Badge tone={attestation.data.status === "verified" ? "safe" : attestation.data.status === "failed" ? "danger" : "neutral"} className="self-start">
              {attestation.data.status}
            </Badge>
          ) : attestation.loading ? (
            <Skeleton className="h-6 w-20" />
          ) : null}
        </div>
        {attestation.data && attestation.data.checks.length > 0 ? (
          <>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {attestation.data.checks.map((check) => (
                <li key={check.name} className="flex items-start gap-2.5 text-[14px]">
                  <span className={cx("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px]", check.passed ? "bg-safe/15 text-safe" : "bg-danger/15 text-danger")} aria-hidden>
                    {check.passed ? "✓" : "✕"}
                  </span>
                  <span className="text-mist-200">
                    {check.name}
                    {check.detail ? <span className="text-mist-400"> · {check.detail}</span> : null}
                    <span className="sr-only">{check.passed ? " passed" : " failed"}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[12.5px] text-mist-400">
              {attestation.data.model ? <span className="num">{attestation.data.model}</span> : null}
              {attestation.data.checkedAt ? ` · checked ${timeAgo(attestation.data.checkedAt, now)}` : null}
            </p>
          </>
        ) : attestation.data ? (
          <p className="mt-3 text-[14px] text-mist-400">No attestation check has run yet, or NEAR AI Cloud didn&apos;t answer. Explanations fall back to a fixed template.</p>
        ) : attestation.error ? (
          <p className="mt-3 text-[14px] text-[#ff8a98]">{attestation.error.message}</p>
        ) : null}
      </Card>
    </section>
  );
}

const STEPS = [
  {
    title: "Fund a reserve from any chain",
    body: "Pay with what you hold. 1Click swaps it into USDC on NEAR, in your own account, and one click moves it into the Lifeline vault.",
  },
  {
    title: "Draw your lines",
    body: "Pick when to warn you, when to rescue and what health to refill to, plus caps per rescue and per day and a cooldown. The vault stores them.",
  },
  {
    title: "The keeper watches",
    body: `Every ${KEEPER_POLL_INTERVAL_SEC} seconds it reads health from Hyperliquid: cross account value divided by maintenance margin. Liquidation comes at 1.0.`,
  },
  {
    title: "It rescues, within your rules",
    body: "Below your trigger it gets a 1Click quote to your perps balance and asks the vault to pay it. The vault checks every rule again, on chain.",
  },
];

function HowItWorks() {
  return (
    <section aria-labelledby="how-title">
      <h2 id="how-title" className="font-display text-[26px] text-paper">How it works</h2>
      <ol className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step, i) => (
          <li key={step.title} className="relative rounded-2xl border border-ink-600/70 bg-ink-800/70 p-5">
            <span className="num text-[13px] text-rescue">0{i + 1}</span>
            <h3 className="mt-2 text-[16px] font-semibold text-paper">{step.title}</h3>
            <p className="mt-2 text-[14px] leading-relaxed text-mist-300">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

const GUARANTEES = [
  ["It can only pay your Hyperliquid address.", "The vault compares every rescue's recipient with the address in your policy and refuses anything else."],
  ["It can't pass your caps.", "Per rescue, per 24 hours and a cooldown between rescues, all enforced by the contract, not by the keeper's good behaviour."],
  ["Its key does one thing.", "The keeper holds only a function-call key for the vault's rescue method. It can't withdraw, transfer or change a policy."],
  ["You stay in charge.", "Pause at once, with no deposit to attach. Unpause and withdraw any time, with a confirmation in your wallet."],
];

function Safety() {
  return (
    <section aria-labelledby="safety-title" className="grid grid-cols-1 gap-8 lg:grid-cols-12">
      <div className="lg:col-span-4">
        <h2 id="safety-title" className="font-display text-[26px] leading-tight text-paper">Built so the keeper doesn&apos;t need your trust</h2>
        <p className="mt-3 text-[15px] leading-relaxed text-mist-300">
          A keeper that holds your money could be hacked. So the rules live in the vault contract on NEAR, where a hacked keeper still can&apos;t break them,
          and every refusal is recorded in the public ledger.
        </p>
        <Link href="/ledger" className="mt-4 inline-block text-[14px] font-medium text-paper underline decoration-ink-500 underline-offset-4 hover:decoration-rescue">
          See the public ledger →
        </Link>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:col-span-8">
        {GUARANTEES.map(([title, body]) => (
          <li key={title} className="rounded-2xl border border-ink-600/70 bg-ink-800/70 p-5">
            <h3 className="text-[15px] font-semibold text-paper">{title}</h3>
            <p className="mt-1.5 text-[14px] leading-relaxed text-mist-300">{body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
