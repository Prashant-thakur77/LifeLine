"use client";

import Link from "next/link";
import { KEEPER_POLL_INTERVAL_SEC } from "@lifeline/shared";
import { usePoll, useNow } from "../hooks/usePoll";
import { config } from "../lib/env";
import { formatLatency, formatUsd, timeAgo } from "../lib/format";
import { keeper } from "../lib/keeper";
import { nearblocksTx } from "../lib/links";
import { HeroWater } from "./HeroWater";
import { Skeleton, cx } from "./ui";

/** The vault's own refusal of a hacked keeper's redirect, on testnet. Re-checked on chain by `pnpm demo:attack`. */
const ATTACK_REFUSED_TX = "A9QZC5bVA1iQUo2CEhksRNFvj77951GrmmJq835joKCn";

export function Landing() {
  return (
    <div className="flex flex-col gap-24 sm:gap-32">
      <HeroWater />
      <Readouts />
      <SoundingLine />
      <Certificate />
      <Livery />
      <Safety />
    </div>
  );
}

function SectionTitle({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  return (
    <h2 id={id} className={cx("font-stencil text-[clamp(34px,4.6vw,64px)] font-bold uppercase leading-[0.9] text-paper", className)}>
      {children}
    </h2>
  );
}

/** The keeper's numbers, as instrument readouts on one rail. */
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
    <section aria-labelledby="stats-title">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionTitle id="stats-title">The keeper so far</SectionTitle>
        <p className="max-w-md font-readout text-[12px] leading-relaxed text-mist-400">
          Live from {new URL(base).host}.
          {simulation ? <span className="text-sim"> Simulation: its rescue times aren&apos;t real settlement times.</span> : null}
        </p>
      </div>
      <dl className="mt-8 grid grid-cols-2 border-y border-ink-600 sm:grid-cols-5" aria-busy={tiles ? undefined : true}>
        {tiles
          ? tiles.map((tile, i) => (
              <div key={tile.label} className={cx("py-5 pr-4 sm:py-7", i > 0 && "sm:border-l sm:border-ink-600 sm:pl-5", i % 2 === 1 && "border-l border-ink-600 pl-4 sm:pl-5", i === 4 && "col-span-2 border-t border-ink-600 sm:col-span-1 sm:border-t-0")}>
                <dt className="font-readout text-[11px] uppercase tracking-[0.08em] text-mist-400">{tile.label}</dt>
                <dd className="mt-3 font-readout text-[clamp(26px,2.9vw,42px)] font-light leading-none tracking-[-0.03em] text-paper tabular-nums [font-stretch:80%]">{tile.value}</dd>
              </div>
            ))
          : stats.error
            ? (
                <div className="col-span-2 py-6 sm:col-span-5">
                  <dt className="sr-only">Keeper stats</dt>
                  <dd className="text-[14px] text-[#ff8a98]">{stats.error.message}</dd>
                </div>
              )
            : Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="py-6 pr-4">
                  <dt className="sr-only">Loading</dt>
                  <dd>
                    <Skeleton className="h-[58px]" />
                  </dd>
                </div>
              ))}
      </dl>
    </section>
  );
}

const STEPS = [
  {
    mark: "Fund",
    title: "A reserve from any chain",
    body: "Pay with what you hold. 1Click swaps it into USDC on NEAR, in your own account, and one click moves it into the Lifeline vault.",
  },
  {
    mark: "Policy",
    title: "Your lines, in the vault",
    body: "When to warn you, when to rescue and what health to refill to, plus caps per rescue and per day and a cooldown. The vault stores them.",
  },
  {
    mark: "Watch",
    title: `A reading every ${KEEPER_POLL_INTERVAL_SEC} seconds`,
    body: "The keeper reads health from Hyperliquid: cross account value divided by maintenance margin. Liquidation comes at 1.0.",
  },
  {
    mark: "Rescue",
    title: "A line thrown, within your rules",
    body: "Below your trigger it gets a signed 1Click quote to your perps balance and asks the vault to pay it. The vault checks every rule again, on chain.",
  },
];

/** How it works, as marks on a lead line. The line fills as it scrolls past. */
function SoundingLine() {
  return (
    <section aria-labelledby="how-title" className="grid grid-cols-1 gap-10 lg:grid-cols-12">
      <div className="lg:col-span-4">
        <div className="lg:sticky lg:top-28">
          <SectionTitle id="how-title">How a rescue happens</SectionTitle>
          <p className="mt-5 max-w-sm text-[15px] leading-relaxed text-mist-300">
            Four marks on one line, from the money you hold to the margin that saves your position.
          </p>
        </div>
      </div>
      <ol className="relative lg:col-span-8">
        <span className="absolute inset-y-2 left-[7px] w-[2px] bg-ink-600" aria-hidden />
        <span className="lead-fill absolute inset-y-2 left-[7px] w-[2px] origin-top bg-rescue" aria-hidden />
        {STEPS.map((step, i) => (
          <li key={step.mark} className="relative pb-14 pl-12 last:pb-0 sm:pl-16">
            <span className="absolute left-0 top-1.5 size-4 border-2 border-rescue bg-ink-900" aria-hidden />
            <p className="font-readout text-[12px] text-rescue">
              {i + 1} · {step.mark}
            </p>
            <h3 className="mt-2 font-stencil text-[clamp(26px,3vw,40px)] font-bold uppercase leading-[0.95] text-paper">{step.title}</h3>
            <p className="mt-3 max-w-xl text-[15.5px] leading-relaxed text-mist-300">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The attestation result, as an inspection certificate pinned to the hull. */
function Certificate() {
  const base = config.keeperApiUrl;
  const attestation = usePoll(`attestation:${base}`, () => keeper.attestation(base), 120_000);
  const now = useNow(10_000);
  const data = attestation.data;
  const stamp = data?.status === "verified" ? "Verified" : data?.status === "failed" ? "Failed" : "Not checked";

  return (
    <section aria-labelledby="cert-title" className="relative bg-paper text-ink-950">
      <div className="grid grid-cols-1 gap-8 p-6 sm:p-10 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <p className="font-readout text-[11px] uppercase tracking-[0.1em] text-ink-600">Inspection · NEAR AI Cloud</p>
          <h2 id="cert-title" className="mt-3 font-stencil text-[clamp(30px,3.8vw,52px)] font-bold uppercase leading-[0.92]">
            The explainer&apos;s hardware, checked
          </h2>
          <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-ink-700">
            Every decision gets a plain-language explanation written from its record. With a NEAR AI key, the keeper adds a sentence from a private
            model on NEAR AI Cloud. Either way it checks, with a fresh nonce, that the model&apos;s hardware is a genuine secure enclave, through NVIDIA
            and Intel.
          </p>
        </div>
        <div className="relative lg:col-span-6">
          <div
            className={cx(
              "absolute -top-2 right-0 rotate-[-7deg] border-[3px] px-3 py-1 font-stencil text-[22px] font-bold uppercase tracking-[0.04em] sm:text-[26px]",
              data?.status === "verified" ? "border-[#0d7a55] text-[#0d7a55]" : data?.status === "failed" ? "border-[#c22b3e] text-[#c22b3e]" : "border-ink-500 text-ink-500",
            )}
            aria-hidden
          >
            {data ? stamp : "…"}
          </div>
          <p className="sr-only">Attestation status: {data ? stamp : "loading"}.</p>
          {data && data.checks.length > 0 ? (
            <ul className="mt-14 divide-y divide-ink-950/15 border-y border-ink-950/15">
              {data.checks.map((check) => (
                <li key={check.name} className="flex items-baseline justify-between gap-4 py-2.5 text-[14px]">
                  <span>
                    {check.name}
                    {check.detail ? <span className="text-ink-600"> · {check.detail}</span> : null}
                  </span>
                  <span className={cx("font-readout text-[12px]", check.passed ? "text-[#0d7a55]" : "text-[#c22b3e]")}>{check.passed ? "pass" : "fail"}</span>
                </li>
              ))}
            </ul>
          ) : data ? (
            <p className="mt-14 text-[14px] text-ink-700">No check has run yet, or NEAR AI Cloud didn&apos;t answer.</p>
          ) : attestation.error ? (
            <p className="mt-14 text-[14px] text-[#c22b3e]">{attestation.error.message}</p>
          ) : (
            <div className="mt-14 h-40 animate-pulse bg-ink-950/5" aria-hidden />
          )}
          {data ? (
            <p className="mt-4 font-readout text-[11.5px] text-ink-600">
              {data.model ?? "model unknown"}
              {data.checkedAt ? ` · checked ${timeAgo(data.checkedAt, now)}` : ""}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Rescue livery: the stripe painted on lifeboats, here as the turn from how it works to why it's safe. */
function Livery() {
  return (
    <div className="relative -mx-4 h-24 overflow-hidden sm:-mx-6 lg:mx-[calc(50%-50vw)]" aria-hidden>
      <div className="absolute inset-x-[-10%] top-1/2 flex -translate-y-1/2 -rotate-[3deg] flex-col gap-2">
        <div className="h-9 bg-rescue" />
        <div className="h-[5px] bg-paper" />
      </div>
    </div>
  );
}

const GUARANTEES = [
  {
    title: "It only pays your Hyperliquid address",
    body: "The vault reads where the money goes from 1Click's signed quote: the deposit address, your Hyperliquid address, the amount and the refund account. Anything else is refused.",
    codes: ["BAD_QUOTE", "RECIPIENT_MISMATCH"],
  },
  {
    title: "It can't pass your caps",
    body: "Per rescue, per 24 hours and a cooldown between rescues, enforced by the contract, not by the keeper's good behaviour.",
    codes: ["OVER_PER_RESCUE", "OVER_DAILY", "COOLDOWN"],
  },
  {
    title: "Its key does one thing",
    body: "The keeper holds a function-call key that can call the vault's rescue method and nothing else. It can't withdraw, transfer or change a policy.",
    codes: ["NOT_KEEPER"],
  },
  {
    title: "You stay in charge",
    body: "Pause at once, with no deposit to attach. Unpause and withdraw any time, with a confirmation in your wallet.",
    codes: ["PAUSED"],
  },
];

function Safety() {
  return (
    <section aria-labelledby="safety-title" className="grid grid-cols-1 gap-10 lg:grid-cols-12">
      <div className="lg:col-span-4">
        <SectionTitle id="safety-title">What a hacked keeper can&apos;t do</SectionTitle>
        <p className="mt-5 max-w-sm text-[15px] leading-relaxed text-mist-300">
          The rules live in the vault contract on NEAR, where a hacked keeper still can&apos;t break them. Each refusal below is a code the contract
          returns.
        </p>
        <div className="mt-6 flex flex-col gap-2 text-[14px]">
          <a
            href={nearblocksTx(ATTACK_REFUSED_TX, "testnet")}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-paper underline decoration-ink-500 underline-offset-4 hover:decoration-rescue"
          >
            See the vault refuse a redirected rescue on testnet ↗
          </a>
          <Link href="/ledger" className="font-medium text-paper underline decoration-ink-500 underline-offset-4 hover:decoration-rescue">
            Read the public ledger →
          </Link>
        </div>
      </div>
      <dl className="border-t border-ink-600 lg:col-span-8">
        {GUARANTEES.map((g) => (
          <div key={g.title} className="grid grid-cols-1 gap-3 border-b border-ink-600 py-6 sm:grid-cols-12 sm:gap-6">
            <dt className="font-stencil text-[22px] font-bold uppercase leading-[1] text-paper sm:col-span-5">{g.title}</dt>
            <dd className="sm:col-span-7">
              <p className="text-[15px] leading-relaxed text-mist-300">{g.body}</p>
              <p className="mt-3 flex flex-wrap gap-2">
                {g.codes.map((code) => (
                  <code key={code} className="border border-ink-500 px-1.5 py-0.5 font-readout text-[11.5px] text-rescue">
                    {code}
                  </code>
                ))}
              </p>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
