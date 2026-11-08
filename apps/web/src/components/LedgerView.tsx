"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { usePoll } from "../hooks/usePoll";
import { config } from "../lib/env";
import { keeper } from "../lib/keeper";
import { groupRecords, matchesFilter, type LedgerFilter } from "../lib/records";
import { EventList } from "./EventList";
import { FilterBar } from "./HistoryView";
import { SimBanner } from "./Viewing";
import { Notice, PageHeader, Skeleton, cx } from "./ui";

/** The public ledger: every user's records from one keeper. */
export function LedgerView() {
  const params = useSearchParams();
  const separateSim = config.keeperApiUrl !== config.simKeeperApiUrl;
  const wantsSim = params.get("source") === "sim";
  const base = separateSim && wantsSim ? config.simKeeperApiUrl : config.keeperApiUrl;

  const info = usePoll(`info:${base}`, () => keeper.info(base), null);
  const ledger = usePoll(`ledger:${base}`, () => keeper.ledger(base, 200), 15_000);
  const events = useMemo(() => groupRecords(ledger.data ?? []), [ledger.data]);
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const shown = events.filter((e) => matchesFilter(e, filter));
  const simulation = (separateSim && wantsSim) || info.data?.mode === "sim";
  const users = new Set(events.map((e) => e.user)).size;

  return (
    <>
      {simulation ? <SimBanner compact /> : null}
      <PageHeader
        eyebrow="Public ledger"
        title="Every rescue and every refusal"
        aside={
          separateSim ? (
            <div className="inline-flex rounded-xl border border-ink-500 bg-ink-850 p-1 text-[13px] font-medium" role="group" aria-label="Keeper">
              <Link href="/ledger" className={cx("rounded-lg px-3 py-1.5", !wantsSim ? "bg-ink-700 text-paper" : "text-mist-300 hover:text-paper")}>
                Live keeper
              </Link>
              <Link href="/ledger?source=sim" className={cx("rounded-lg px-3 py-1.5", wantsSim ? "bg-ink-700 text-paper" : "text-mist-300 hover:text-paper")}>
                Simulation
              </Link>
            </div>
          ) : null
        }
      >
        The keeper&apos;s log for every account it watches, newest first: each warning, each rescue it sent, and each one its policy engine or the vault refused.
        Anyone can check it. Nothing in it can be changed afterwards.
      </PageHeader>

      {ledger.data ? (
        <p className="mb-4 text-[13px] text-mist-400">
          {events.length} events across {users} {users === 1 ? "account" : "accounts"}, from the latest 200 records. Refreshes every 15 s.
        </p>
      ) : null}

      <FilterBar filter={filter} onChange={setFilter} events={events} />

      {ledger.loading ? (
        <div className="space-y-3">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : ledger.error && !ledger.data ? (
        <Notice tone="danger" title="Couldn't load the ledger" action={<button className="text-paper underline" onClick={ledger.refresh}>Try again</button>}>
          {ledger.error.message}
        </Notice>
      ) : shown.length === 0 ? (
        <Notice tone="info" title={events.length === 0 ? "The ledger is empty" : "Nothing matches this filter"}>
          {events.length === 0 ? "This keeper hasn't recorded anything yet." : "Try another filter."}
        </Notice>
      ) : (
        <EventList events={shown} showUser />
      )}
    </>
  );
}
