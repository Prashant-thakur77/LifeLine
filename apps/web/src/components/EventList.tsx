"use client";

import Link from "next/link";
import { useState } from "react";
import { config } from "../lib/env";
import { formatHealth, formatLatency, timeAgo } from "../lib/format";
import { eventLinks, pageHref } from "../lib/links";
import { OUTCOME_LABEL, describeReason, eventTitle, type LedgerEvent, type Outcome } from "../lib/records";
import { useNow } from "../hooks/usePoll";
import { Badge, Button, ExternalLink, type Tone } from "./ui";

const OUTCOME_TONE: Record<Outcome, Tone> = {
  done: "safe",
  "in-progress": "rescue",
  failed: "danger",
  blocked: "warn",
  warn: "neutral",
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
  if (before === null && after === null) return <span className="text-muted">—</span>;
  return (
    <span className="num whitespace-nowrap text-[13px]">
      <span className="text-rescue-ink">{formatHealth(before)}</span>
      {after !== null ? (
        <>
          <span className="mx-1 text-muted" aria-label="to">
            →
          </span>
          <span className="text-safe-ink">{formatHealth(after)}</span>
        </>
      ) : null}
    </span>
  );
}

/** One event as one row of the proof table; its steps, explanation and links open beneath it. */
function EventRow({ event, showUser, now }: { event: LedgerEvent; showUser: boolean; now: number }) {
  const [open, setOpen] = useState(false);
  const links = eventLinks(event, config.network);
  const id = `ev-${event.key.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <li className="group">
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3.5 sm:grid-cols-[110px_120px_1fr_120px_96px_auto] sm:px-5">
        <time dateTime={event.at} title={clock(event.at)} className="order-2 font-readout text-[12px] text-muted sm:order-none">
          {timeAgo(event.at, now)}
        </time>
        <span className="order-1 flex flex-wrap items-center gap-1.5 sm:order-none">
          <Badge tone={OUTCOME_TONE[event.outcome]}>{OUTCOME_LABEL[event.outcome]}</Badge>
          {event.simulated ? <Badge tone="sim">Sim</Badge> : null}
        </span>
        <span className="order-3 col-span-2 min-w-0 sm:order-none sm:col-span-1">
          <span className="block text-[15px] font-semibold leading-snug text-ink">{eventTitle(event, config.usdcContractId)}</span>
          {showUser ? (
            <Link href={pageHref("/history", event.user)} className="text-[13px] text-body underline decoration-line-strong underline-offset-2 hover:text-ink">
              {event.user}
            </Link>
          ) : null}
        </span>
        <span className="order-4 sm:order-none">
          <HealthChange before={event.healthBefore} after={event.outcome === "done" || event.outcome === "failed" ? event.healthAfter : null} />
        </span>
        <span className="order-5 font-readout text-[12.5px] text-ink-2 sm:order-none">
          {event.latencyMs !== null && event.outcome === "done" ? formatLatency(event.latencyMs) : ""}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={id}
          className="order-6 justify-self-end rounded-md border-2 border-ink px-2.5 py-1 text-[12.5px] font-semibold text-ink hover:bg-sun sm:order-none"
        >
          {open ? "Hide" : "Details"}
        </button>
      </div>
      {open ? (
        <div id={id} className="border-t-2 border-dashed border-ink/15 bg-paper/60 px-4 py-4 text-[13.5px] sm:px-5">
          {event.outcome === "blocked" && event.reasons.length > 0 ? (
            <ul className="mb-3 space-y-1.5 text-ink-2">
              {event.reasons.map((reason) => (
                <li key={reason} className="flex gap-2">
                  <code className="shrink-0 rounded-sm bg-sun px-1.5 font-readout text-[11px] text-ink">{reason}</code>
                  <span>{describeReason(reason)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {event.explanation ? <p className="mb-3 max-w-3xl border-l-[3px] border-rescue pl-3 text-[14.5px] leading-relaxed text-ink">{event.explanation}</p> : null}
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
              {event.oneClickStatus ? (
                <>
                  <dt className="text-muted">1Click status</dt>
                  <dd className="num text-ink-2">{event.oneClickStatus}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            {links.map((link) => (
              <ExternalLink key={link.label} href={link.href}>
                {link.label}
              </ExternalLink>
            ))}
            {event.simulated && event.outcome !== "warn" ? <span className="text-muted">Simulated: nothing on chain to link to.</span> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

const PAGE = 25;

/** The proof table: newest first, 25 rows at a time. */
export function EventList({ events, showUser = false }: { events: LedgerEvent[]; showUser?: boolean }) {
  const now = useNow(5000);
  const [count, setCount] = useState(PAGE);
  const shown = events.slice(0, count);
  const explained = events.some((e) => e.explanation);
  return (
    <div>
      <ol className="divide-y-2 divide-ink/10 overflow-hidden rounded-xl border-2 border-ink bg-card">
        {shown.map((event) => (
          <EventRow key={event.key} event={event} showUser={showUser} now={now} />
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[13px] text-muted">
        <span>
          {shown.length} of {events.length} shown.
          {explained ? " Explanations are written from each record; a keeper with a NEAR AI key adds a sentence from a model in attested hardware, kept only when its signature verifies." : ""}
        </span>
        {count < events.length ? (
          <Button size="sm" variant="secondary" onClick={() => setCount((c) => c + PAGE)}>
            Show {Math.min(PAGE, events.length - count)} more
          </Button>
        ) : null}
      </div>
    </div>
  );
}
