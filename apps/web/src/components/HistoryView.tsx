"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { usePoll } from "../hooks/usePoll";
import { config } from "../lib/env";
import { keeper } from "../lib/keeper";
import { formatUnits, shortMiddle } from "../lib/format";
import { intentsExplorer, nearblocksAccount, pageHref } from "../lib/links";
import { LEDGER_FILTERS, groupRecords, matchesFilter, tokenMeta, type LedgerEvent, type LedgerFilter } from "../lib/records";
import { nsToIso, vaultViews } from "../lib/vault";
import { EventList } from "./EventList";
import { AccountChooser, SimBanner, useIsSimulation, useViewedUser } from "./Viewing";
import { Badge, Card, CardHeader, ExternalLink, Notice, PageHeader, Skeleton, cx } from "./ui";

export function HistoryView() {
  const { user } = useViewedUser();
  if (!user) {
    return (
      <>
        <PageHeader eyebrow="History" title="Every warning and rescue, explained">
          The keeper writes down each decision it makes for an account, with a plain-language explanation and links to check it on chain.
        </PageHeader>
        <AccountChooser path="/history" purpose="Connect your NEAR wallet to see your own history, or look up any account." />
      </>
    );
  }
  return <History key={user} user={user} />;
}

function History({ user }: { user: string }) {
  const { simulation, keeperBase } = useIsSimulation(user);
  const audit = usePoll(`audit:${keeperBase}:${user}`, () => keeper.audit(keeperBase, user, 200), 15_000);
  const events = useMemo(() => groupRecords(audit.data ?? []), [audit.data]);
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const shown = events.filter((e) => matchesFilter(e, filter));

  return (
    <>
      {simulation ? <SimBanner /> : null}
      <PageHeader
        eyebrow="History"
        title={user}
        aside={
          <Link href={pageHref("/position", user)} className="text-[14px] text-body hover:text-ink">
            ← Back to position
          </Link>
        }
      >
        Each warning, rescue and refusal the keeper recorded for this account, newest first. The keeper&apos;s log can&apos;t be edited: its storage refuses
        updates and deletes.
      </PageHeader>

      <Summary events={events} loading={audit.loading} />

      <FilterBar filter={filter} onChange={setFilter} events={events} />

      {audit.loading ? (
        <div className="space-y-3">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : audit.error && !audit.data ? (
        <Notice tone="danger" title="Couldn't load the history" action={<button className="text-ink underline" onClick={audit.refresh}>Try again</button>}>
          {audit.error.message}
        </Notice>
      ) : shown.length === 0 ? (
        <Notice tone="info" title={events.length === 0 ? "Nothing yet" : "Nothing matches this filter"}>
          {events.length === 0 ? "No warnings or rescues for this account so far. When health crosses a line, it shows up here." : "Try another filter."}
        </Notice>
      ) : (
        <EventList events={shown} />
      )}

      {!simulation ? <OnChainRescues user={user} /> : null}
    </>
  );
}

function Summary({ events, loading }: { events: LedgerEvent[]; loading: boolean }) {
  const count = (outcome: LedgerEvent["outcome"]) => events.filter((e) => e.outcome === outcome).length;
  const items = [
    { label: "Rescued", value: count("done"), color: "text-safe-ink" },
    { label: "Blocked", value: count("blocked"), color: "text-warn-ink" },
    { label: "Failed", value: count("failed"), color: "text-danger-ink" },
    { label: "Warnings", value: count("warn"), color: "text-ink" },
  ];
  return (
    <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-xl border-2 border-ink bg-card shadow-[3px_3px_0_var(--color-ink)] px-4 py-3">
          <dt className="text-[12px] text-muted">{item.label}</dt>
          <dd className={cx("num mt-1 text-[24px]", item.color)}>{loading ? "…" : item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FilterBar({ filter, onChange, events }: { filter: LedgerFilter; onChange: (f: LedgerFilter) => void; events: LedgerEvent[] }) {
  return (
    <div className="scrollbar-none -mx-4 mb-5 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="group" aria-label="Filter">
      {LEDGER_FILTERS.map((f) => {
        const n = events.filter((e) => matchesFilter(e, f.id)).length;
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onChange(f.id)}
            aria-pressed={filter === f.id}
            className={cx(
              "shrink-0 rounded-md border-2 border-ink px-3 py-1.5 text-[13.5px] font-semibold transition-colors",
              filter === f.id ? "bg-ink text-paper [&_.num]:text-sun" : "bg-card text-ink hover:bg-sun",
            )}
          >
            {f.label} <span className="num ml-1 text-muted">{n}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The vault's own record of rescues: what actually left the reserve, readable by anyone. */
function OnChainRescues({ user }: { user: string }) {
  const vault = config.vaultId;
  const rescues = usePoll(vault ? `rescues:${vault}:${user}` : null, () => vaultViews.rescues(config.rpcUrl, vault!, user, 0, 100), 30_000);
  return (
    <Card className="mt-10">
      <CardHeader
        eyebrow="Straight from the vault contract"
        title="On-chain rescues"
        action={vault ? <ExternalLink href={nearblocksAccount(vault, config.network)} className="text-[13px] text-body">Vault on NearBlocks</ExternalLink> : null}
      />
      <div className="p-5 text-[14px]">
        {!vault ? (
          <p className="text-body">The vault isn&apos;t deployed yet. Once it is, every rescue it paid out shows here, read from the chain rather than the keeper.</p>
        ) : rescues.loading ? (
          <Skeleton className="h-16" />
        ) : rescues.error ? (
          <p className="text-danger-ink">{rescues.error.message}</p>
        ) : (rescues.data ?? []).length === 0 ? (
          <p className="text-body">The vault has paid no rescues for this account.</p>
        ) : (
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left">
              <thead>
                <tr className="text-[12px] uppercase tracking-[0.08em] text-muted">
                  <th className="px-2 py-2 font-medium">When</th>
                  <th className="px-2 py-2 text-right font-medium">Amount</th>
                  <th className="px-2 py-2 font-medium">To</th>
                  <th className="px-2 py-2 font-medium">1Click deposit</th>
                </tr>
              </thead>
              <tbody>
                {[...(rescues.data ?? [])].reverse().map((r) => {
                  const meta = tokenMeta(r.token, config.usdcContractId);
                  const at = nsToIso(r.at);
                  return (
                    <tr key={`${r.quote_id}-${r.at}`} className="border-t-2 border-ink/10">
                      <td className="px-2 py-2.5 text-ink-2">{at ? new Date(at).toLocaleString() : "—"}</td>
                      <td className="num px-2 py-2.5 text-right text-ink">
                        {formatUnits(r.amount, meta.decimals)} {meta.symbol}
                        {r.refunded ? <Badge tone="warn" className="ml-2">Refunded</Badge> : null}
                      </td>
                      <td className="num px-2 py-2.5 text-ink-2">{shortMiddle(r.recipient)}</td>
                      <td className="num px-2 py-2.5">
                        <ExternalLink href={intentsExplorer(r.deposit_address)} className="text-ink-2">
                          {shortMiddle(r.deposit_address, 8, 6)}
                        </ExternalLink>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
