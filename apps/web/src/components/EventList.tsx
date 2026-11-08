"use client";

import Link from "next/link";
import { useState } from "react";
import { config } from "../lib/env";
import { formatHealth, formatLatency, timeAgo } from "../lib/format";
import { eventLinks, pageHref } from "../lib/links";
import { OUTCOME_LABEL, describeReason, eventTitle, type LedgerEvent, type Outcome } from "../lib/records";
import { useNow } from "../hooks/usePoll";
import { Badge, ExternalLink, cx, type Tone } from "./ui";

const OUTCOME_TONE: Record<Outcome, Tone> = {
  done: "safe",
  "in-progress": "rescue",
  failed: "danger",
  blocked: "warn",
  warn: "neutral",
};

const RAIL: Record<Outcome, string> = {
  done: "bg-safe",
  "in-progress": "bg-rescue",
  failed: "bg-danger",
  blocked: "bg-warn",
  warn: "bg-muted",
};

const STEP_LABEL: Record<string, string> = {
  WARN: "Warned",
  RESCUE_ALLOWED: "Policy allowed it, rescue sent",
  RESCUE_BLOCKED: "Policy refused it",
  RESCUE_DONE: "USDC credited on Hyperliquid",
  RESCUE_FAILED: "Rescue failed",
};

const clock = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function HealthChange({ before, after }: { before: number | null; after: number | null }) {
  if (before === null && after === null) return null;
  return (
    <span className="num inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-2 py-0.5 text-[13px]">
      <span className="text-muted">health</span>
      <span className="text-rescue-ink">{formatHealth(before)}</span>
      {after !== null ? (
        <>
          <span className="text-muted" aria-label="to">
            →
          </span>
          <span className="text-safe-ink">{formatHealth(after)}</span>
        </>
      ) : null}
    </span>
  );
}

function EventItem({ event, showUser, now }: { event: LedgerEvent; showUser: boolean; now: number }) {
  const [open, setOpen] = useState(false);
  const links = eventLinks(event, config.network);
  return (
    <li className="relative pl-7">
      <span className={cx("absolute left-[7px] top-[9px] size-[11px] rounded-full ring-4 ring-paper", RAIL[event.outcome])} aria-hidden />
      <article className="rounded-xl border-2 border-ink bg-card shadow-[3px_3px_0_var(--color-ink)] p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={OUTCOME_TONE[event.outcome]}>{OUTCOME_LABEL[event.outcome]}</Badge>
          {event.simulated ? <Badge tone="sim">Sim</Badge> : null}
          <time dateTime={event.at} title={clock(event.at)} className="ml-auto text-[12.5px] text-muted">
            {timeAgo(event.at, now)}
          </time>
        </div>
        <h3 className="mt-2.5 text-[16px] font-semibold leading-snug text-ink">{eventTitle(event, config.usdcContractId)}</h3>
        {showUser ? (
          <Link href={pageHref("/history", event.user)} className="mt-0.5 inline-block text-[13px] text-body hover:text-ink">
            {event.user}
          </Link>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <HealthChange before={event.healthBefore} after={event.outcome === "done" || event.outcome === "failed" ? event.healthAfter : null} />
          {event.latencyMs !== null && event.outcome === "done" ? (
            <span className="num rounded-lg border border-line bg-card px-2 py-0.5 text-[13px] text-ink-2">
              {formatLatency(event.latencyMs)} {event.simulated ? "(simulated)" : "end to end"}
            </span>
          ) : null}
          {event.oneClickStatus && event.oneClickStatus !== "SUCCESS" ? (
            <span className="num rounded-lg border border-line bg-card px-2 py-0.5 text-[13px] text-ink-2">1Click: {event.oneClickStatus}</span>
          ) : null}
        </div>

        {event.outcome === "blocked" && event.reasons.length > 0 ? (
          <ul className="mt-3 space-y-1.5 text-[14px] text-ink-2">
            {event.reasons.map((reason) => (
              <li key={reason} className="flex gap-2">
                <span className="num mt-[3px] shrink-0 rounded bg-warn/10 px-1.5 text-[11px] text-warn-ink">{reason}</span>
                <span>{describeReason(reason)}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {event.explanation ? (
          <blockquote className="mt-3 border-l-2 border-rescue/50 pl-3 text-[14.5px] leading-relaxed text-ink">
            {event.explanation}
            <footer className="mt-1 text-[12px] text-muted">Written from the record. A keeper with a NEAR AI key adds a sentence from a model in attested hardware.</footer>
          </blockquote>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-body">
          {links.map((link) => (
            <ExternalLink key={link.label} href={link.href}>
              {link.label}
            </ExternalLink>
          ))}
          {event.simulated && event.outcome !== "warn" ? <span className="text-muted">Simulated: nothing on chain to link to.</span> : null}
          {event.records.length > 1 || event.request ? (
            <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="ml-auto text-body underline decoration-line-strong underline-offset-[3px] hover:text-ink">
              {open ? "Hide steps" : "Steps"}
            </button>
          ) : null}
        </div>

        {open ? (
          <div className="mt-3 rounded-lg border-2 border-ink bg-card p-3 text-[13px]">
            <ol className="space-y-1.5">
              {event.records.map((record) => (
                <li key={record.id} className="flex flex-wrap justify-between gap-x-3">
                  <span className="text-ink-2">{STEP_LABEL[record.kind] ?? record.kind}</span>
                  <time className="num text-muted" dateTime={record.at}>
                    {clock(record.at)}
                  </time>
                </li>
              ))}
            </ol>
            {event.request ? (
              <dl className="mt-3 grid gap-1.5 border-t-2 border-ink/10 pt-3 sm:grid-cols-[auto_1fr] sm:gap-x-4">
                <dt className="text-muted">Recipient</dt>
                <dd className="num break-all text-ink-2">{event.request.recipient}</dd>
                <dt className="text-muted">Deposit address</dt>
                <dd className="num break-all text-ink-2">{event.request.depositAddress}</dd>
                <dt className="text-muted">Quote</dt>
                <dd className="num break-all text-ink-2">{event.request.quoteId}</dd>
                <dt className="text-muted">Needed</dt>
                <dd className="num text-ink-2">${event.request.usdNeeded.toFixed(2)}</dd>
              </dl>
            ) : null}
          </div>
        ) : null}
      </article>
    </li>
  );
}

export function EventList({ events, showUser = false }: { events: LedgerEvent[]; showUser?: boolean }) {
  const now = useNow(5000);
  return (
    <ol className="relative space-y-3 before:absolute before:bottom-4 before:left-[12px] before:top-4 before:w-px before:bg-shade">
      {events.map((event) => (
        <EventItem key={event.key} event={event} showUser={showUser} now={now} />
      ))}
    </ol>
  );
}
