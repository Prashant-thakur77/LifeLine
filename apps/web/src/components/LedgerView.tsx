"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { usePoll } from "../hooks/usePoll";
import { config } from "../lib/env";
import { keeper } from "../lib/keeper";
import { groupRecords, matchesFilter, type LedgerFilter } from "../lib/records";
import { EventList } from "./EventList";
import { RefusalReceipt } from "./RefusalReceipt";
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
            <div className="inline-flex rounded-lg border-2 border-ink bg-card p-1 text-[13px] font-medium" role="group" aria-label="Keeper">
              <Link href="/ledger" className={cx("rounded-lg px-3 py-1.5", !wantsSim ? "bg-shade text-ink" : "text-body hover:text-ink")}>
                Live keeper
              </Link>
              <Link href="/ledger?source=sim" className={cx("rounded-lg px-3 py-1.5", wantsSim ? "bg-shade text-ink" : "text-body hover:text-ink")}>
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
        <p className="mb-4 text-[13px] text-muted">
          {events.length} events across {users} {users === 1 ? "account" : "accounts"}, from the latest 200 records. Refreshes every 15 s.
        </p>
      ) : null}

      <section aria-labelledby="pinned-title" className="mb-8 grid grid-cols-1 items-start gap-5 rounded-xl border-2 border-ink bg-sea p-5 text-paper sm:p-6 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <p className="font-readout text-[11px] uppercase tracking-[0.1em] text-paper">Pinned · on chain</p>
          <h2 id="pinned-title" className="mt-2 text-[clamp(26px,3vw,38px)] font-extrabold uppercase leading-[0.92] [font-variation-settings:'wdth'_72]">
            The vault refusing a hacked keeper
          </h2>
          <p className="mt-3 text-[14.5px] leading-relaxed text-paper/90">
            The keeper&apos;s own restricted key called rescue with the user&apos;s real address and a correctly signed quote, but pointed the money at itself. The
            contract refused. On testnet the vault trusts a team key in place of 1Click&apos;s, because 1Click has no testnet; <code className="font-readout text-[12.5px]">pnpm demo:attack</code> re-checks this
            transaction on a public node.
          </p>
        </div>
        <RefusalReceipt className="lg:col-span-7" />
      </section>

      <FilterBar filter={filter} onChange={setFilter} events={events} />

      {ledger.loading ? (
        <div className="space-y-3">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : ledger.error && !ledger.data ? (
        <Notice tone="danger" title="Couldn't load the ledger" action={<button className="text-ink underline" onClick={ledger.refresh}>Try again</button>}>
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
