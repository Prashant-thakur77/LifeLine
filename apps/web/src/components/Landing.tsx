"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { KEEPER_POLL_INTERVAL_SEC } from "@lifeline/shared";
import { usePoll, useNow } from "../hooks/usePoll";
import { config } from "../lib/env";
import { formatLatency, formatUsd, timeAgo } from "../lib/format";
import { keeper } from "../lib/keeper";
import { nearblocksTx } from "../lib/links";
import { REFUSED_RESCUE } from "../lib/proof";
import { FundScene, PolicyScene, RescueScene, WatchScene } from "./art/Scenes";
import { HeroWater } from "./HeroWater";
import { Skeleton, cx } from "./ui";

export function Landing() {
  return (
    <div className="flex flex-col">
      <HeroWater />
      <Readouts />
      <HowItWorks />
      <Marquee />
      <Safety />
      <Certificate />
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
                <dd className="mt-3 font-readout text-[clamp(28px,3.2vw,48px)] font-light leading-none tracking-[-0.04em] text-ink tabular-nums [font-variation-settings:'wdth'_80]">
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
    </section>
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
    <section aria-labelledby="how-title" className="mt-28 sm:mt-32">
      <div className="grid grid-cols-1 items-end gap-6 lg:grid-cols-12">
        <SectionTitle id="how-title" className="text-ink lg:col-span-7">
          How a rescue <span className="riso text-sea">happens</span>
        </SectionTitle>
        <p className="max-w-md text-[16px] leading-relaxed text-body lg:col-span-5">
          From the money you hold to the margin that saves your position, in four steps. The last two run on their own, every {KEEPER_POLL_INTERVAL_SEC}{" "}
          seconds.
        </p>
      </div>
      <ol className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map(({ title, body, Art, tint }, i) => (
          <li key={title} className="pop-in flex flex-col overflow-hidden rounded-xl border-2 border-ink bg-card shadow-[6px_6px_0_var(--color-ink)]">
            <div className={cx("border-b-2 border-ink", tint)}>
              <Art />
            </div>
            <div className="flex flex-1 flex-col p-5">
              <p className="font-readout text-[12px] text-rescue-ink">Step {i + 1}</p>
              <h3 className="mt-1.5 text-[20px] font-bold leading-snug text-ink">{title}</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-body">{body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Livery band with one sentence moving through it, slowly. */
function Marquee() {
  const line = "A hacked keeper still can't redirect the money";
  return (
    <div className="relative -mx-4 mt-28 overflow-hidden py-3 sm:-mx-6 sm:mt-32 lg:mx-[calc(50%-50vw)]" aria-hidden>
      <div className="-rotate-[2deg] scale-[1.04] border-y-[3px] border-ink bg-rescue py-4">
        <div className="marquee flex w-max gap-10 whitespace-nowrap text-[clamp(28px,4vw,56px)] font-black uppercase leading-none text-ink [font-variation-settings:'wdth'_118]">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="flex items-center gap-10">
              {line}
              <span className="inline-block size-[0.55em] rounded-full border-[0.12em] border-ink bg-paper" />
            </span>
          ))}
        </div>
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
  { title: "It can't pass your caps", body: "Per rescue, per 24 hours and a cooldown between rescues, enforced by the contract, not by the keeper's good behaviour.", codes: ["OVER_PER_RESCUE", "OVER_DAILY", "COOLDOWN"] },
  { title: "Its key does one thing", body: "The keeper holds a function-call key that can call the vault's rescue method and nothing else. It can't withdraw, transfer or change a policy.", codes: ["NOT_KEEPER"] },
  { title: "You stay in charge", body: "Pause at once, with no deposit to attach. Unpause and withdraw any time, with a confirmation in your wallet.", codes: ["PAUSED"] },
];

/** What a hacked keeper can't do: a ship's safety notice, with the real refusal pinned beside it. */
function Safety() {
  return (
    <section aria-labelledby="safety-title" className="mt-24 sm:mt-28">
      <div className="overflow-hidden rounded-2xl border-[3px] border-ink bg-sea text-paper shadow-[8px_8px_0_var(--color-ink)]">
        <div className="grid grid-cols-1 gap-10 p-6 sm:p-10 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <p className="font-readout text-[11px] uppercase tracking-[0.12em] text-sun">Safety notice · vault contract on NEAR</p>
            <SectionTitle id="safety-title" className="mt-4 text-paper">
              What a hacked keeper can&apos;t do
            </SectionTitle>
            <p className="mt-5 max-w-sm text-[16px] leading-relaxed text-paper/90">
              The rules live in the vault contract, where a hacked keeper still can&apos;t break them. Each code below is what the contract answers when it refuses.
            </p>
            <Refusal />
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

/** The vault refusing a hacked keeper on chain, printed as a ticket. */
function Refusal() {
  const r = REFUSED_RESCUE;
  return (
    <figure className="mt-8 -rotate-1 rounded-md bg-paper text-ink shadow-[0_18px_30px_-18px_rgb(11_21_51/0.8)]">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-2 border-dashed border-ink/30 px-4 py-3">
        <span className="font-readout text-[15px] font-semibold text-danger-ink">Refused: {r.panic.split(":")[0]}</span>
        <span className="font-readout text-[11px] text-muted">
          on chain · {r.network} · {new Date(r.at).toISOString().slice(0, 16).replace("T", " ")} UTC
        </span>
      </figcaption>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-4 py-4 font-readout text-[12px]">
        <dt className="text-muted">From</dt>
        <dd className="break-words">{r.signer}</dd>
        <dt className="text-muted">Called</dt>
        <dd className="break-words">
          {r.vault}
          <span className="whitespace-nowrap"> · {r.method}</span>
        </dd>
        <dt className="text-muted">Answer</dt>
        <dd className="text-danger-ink">{r.panic}</dd>
      </dl>
      <p className="border-t-2 border-dashed border-ink/30 px-4 pb-4 pt-3 text-[13px]">
        <a href={nearblocksTx(r.txHash, r.network)} target="_blank" rel="noreferrer noopener" className="font-semibold underline decoration-rescue decoration-2 underline-offset-4">
          See the transaction&nbsp;↗
        </a>
        <span className="text-muted"> · the keeper&apos;s own key, a correctly signed quote, the money pointed at itself</span>
      </p>
    </figure>
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
            Every decision gets a plain-language explanation written from its record. With a NEAR AI key, the keeper adds a sentence from a private model on NEAR AI
            Cloud. Either way it checks, with a fresh nonce, that the model&apos;s hardware is a genuine secure enclave, through NVIDIA and Intel.
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
