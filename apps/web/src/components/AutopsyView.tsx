"use client";

import type { Aftermath, Liquidation } from "@lifeline/hyperliquid";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { usePoll } from "../hooks/usePoll";
import { WINDOW_LABEL, dayOf, liquidationLine, sentence, signedUsd, tally } from "../lib/autopsy-text";
import { formatPrice, formatUsd } from "../lib/format";
import { readAftermath, readLiquidations } from "../lib/hl";
import { Mark } from "./Shell";
import { Button, ButtonLink, Card, Notice, PageHeader, Skeleton, cx, inputClass } from "./ui";

const SHOWN = 12;
const HOURS = [24, 72, 168] as const;

/** Every liquidation an address has had lately, and what came after it. Hindsight, and it says so. */
export function AutopsyView() {
  const params = useSearchParams();
  const router = useRouter();
  const address = params.get("address")?.trim() ?? "";
  const [draft, setDraft] = useState(address);
  useEffect(() => setDraft(address), [address]);
  const reading = usePoll(address ? `autopsy:${address}` : null, () => readLiquidations(address), null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = draft.trim();
    router.replace(value ? `/autopsy?address=${encodeURIComponent(value)}` : "/autopsy");
  };
  return (
    <>
      <PageHeader eyebrow="Liquidation autopsy" title="What if you'd held on?">
        Paste an address. For each liquidation, see how much more margin would have carried it through, and whether that would have been worth it. Sometimes it wouldn&apos;t.
      </PageHeader>
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor="autopsy-address" className="sr-only">
          Hyperliquid address
        </label>
        <input id="autopsy-address" className={cx(inputClass, "num sm:flex-1")} placeholder="0x… any Hyperliquid address" value={draft} onChange={(e) => setDraft(e.target.value)} autoCapitalize="none" spellCheck={false} />
        <Button type="submit" variant="primary" size="lg">
          Open the file
        </Button>
      </form>
      {!address ? null : reading.error ? (
        <Notice tone="warn" title="Couldn't read it" className="mt-8">
          {reading.error.message}
        </Notice>
      ) : reading.data === undefined ? (
        <Skeleton className="mt-8 h-64" />
      ) : reading.data.length === 0 ? (
        <div className="mt-8 flex flex-col items-start gap-4 rounded-xl border-2 border-ink bg-[#d8f5ec] p-6">
          <p className="text-[26px] font-bold leading-tight">No liquidations in its latest 2,000 trades.</p>
          <p className="max-w-xl text-[15px] text-body">Hyperliquid gives out only the most recent trades, so an older one wouldn&apos;t show.</p>
          <ButtonLink href={`/check?address=${encodeURIComponent(address)}`}>See how close it is now</ButtonLink>
        </div>
      ) : (
        <Files key={address} list={reading.data} />
      )}
    </>
  );
}

function Files({ list }: { list: Liquidation[] }) {
  const shown = list.slice(0, SHOWN);
  const [after, setAfter] = useState<Record<string, Aftermath[] | "failed">>({});
  const [hours, setHours] = useState<(typeof HOURS)[number]>(24);
  useEffect(() => {
    let live = true;
    void (async () => {
      // One at a time: each asks Hyperliquid for a week of prices.
      for (const l of shown) {
        const result = await readAftermath(l, Date.now()).catch(() => "failed" as const);
        if (!live) return;
        setAfter((a) => ({ ...a, [l.id]: result }));
      }
    })();
    return () => {
      live = false;
    };
    // The list belongs to one address, and this component is keyed by it.
  }, []);
  const read = shown.map((l) => after[l.id]).map((a) => (a === "failed" ? undefined : a));
  const { recovered, total } = tally(read, hours);
  const done = Object.keys(after).length === shown.length;
  return (
    <div className="mt-8">
      <div className="grid gap-6 rounded-xl border-2 border-ink bg-ink p-6 text-paper lg:grid-cols-[1fr_auto] lg:items-end">
        <p className="text-[clamp(28px,4.4vw,60px)] font-extrabold uppercase leading-[0.9] [font-variation-settings:'wdth'_70]" aria-live="polite">
          {total === 0 ? (
            done ? (
              `No prices kept for ${WINDOW_LABEL[hours]}`
            ) : (
              "Opening the files…"
            )
          ) : (
            <>
              <span className="text-sun">
                {recovered} of {total}
              </span>{" "}
              came back within {WINDOW_LABEL[hours]}
            </>
          )}
        </p>
        <div role="group" aria-label="How long to look" className="flex gap-2">
          {HOURS.map((h) => (
            <button key={h} type="button" aria-pressed={hours === h} onClick={() => setHours(h)} className={cx("rounded-lg border-2 border-paper px-3 py-1.5 text-[14px] font-bold", hours === h ? "bg-sun text-ink" : "hover:bg-paper/15")}>
              {WINDOW_LABEL[h]}
            </button>
          ))}
        </div>
      </div>
      <ol className="mt-5 grid gap-5 lg:grid-cols-2">
        {shown.map((l, i) => (
          <File key={l.id} n={i + 1} l={l} after={after[l.id]} hours={hours} />
        ))}
      </ol>
      {list.length > SHOWN ? <p className="mt-4 text-[14px] text-muted">The newest {SHOWN} of {list.length} liquidations.</p> : null}
      <p className="mt-6 max-w-3xl text-[13.5px] leading-relaxed text-muted">
        Hindsight on each position alone: other positions and funding aren&apos;t counted, sizes are what was liquidated, and prices come from Hyperliquid&apos;s candles, which are daily for old dates. If the position was
        isolated, a Lifeline top-up couldn&apos;t have reached it. Past recoveries say nothing about the next one.
      </p>
      <div className="mt-8 flex flex-col items-start justify-between gap-5 rounded-2xl border-2 border-ink bg-rescue p-6 sm:flex-row sm:items-center">
        <p className="max-w-lg text-[clamp(24px,3vw,38px)] font-extrabold uppercase leading-[0.95] [font-variation-settings:'wdth'_72]">Next time, let something stay awake</p>
        <div className="flex flex-wrap items-center gap-3">
          <Mark className="size-12" quarters="#0b1533" />
          <ButtonLink href="/waitlist" size="lg">
            Get a berth
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}

function File({ n, l, after, hours }: { n: number; l: Liquidation; after: Aftermath[] | "failed" | undefined; hours: number }) {
  const a = Array.isArray(after) ? after.find((x) => x.hours === hours) : undefined;
  const back = a !== undefined && a.againstLiquidationUsd > 0;
  return (
    <li>
      <Card className="flex h-full flex-col overflow-hidden">
        <div className={cx("flex items-baseline justify-between gap-3 border-b-2 border-ink px-5 py-3", a === undefined ? "bg-shade" : back ? "bg-safe" : "bg-[#ffd0d5]")}>
          <h2 className="min-w-0 break-words text-[17px] font-bold">{liquidationLine(l)}</h2>
          <span className="shrink-0 font-readout text-[11px]">No. {n}</span>
        </div>
        <div className="flex flex-1 flex-col gap-4 p-5">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {(
              [
                ["When", dayOf(l.endedAt)],
                ["Size", formatUsd(l.size * l.price)],
                ["Booked", signedUsd(l.pnlUsd)],
                ...(a ? ([["Worst after", formatPrice(a.worst)], [`After ${WINDOW_LABEL[hours]}`, formatPrice(a.end)], ["Holding on", signedUsd(a.againstLiquidationUsd)]] as const) : []),
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-[12px] text-muted">{label}</dt>
                <dd className="num break-words text-[15px] font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-auto text-[15.5px] font-semibold leading-snug">
            {after === undefined ? "Reading the prices that came after…" : after === "failed" ? "The prices that came after couldn't be read." : a ? sentence(l, a) : `Hyperliquid's prices don't cover ${WINDOW_LABEL[hours]} after this one.`}
          </p>
        </div>
      </Card>
    </li>
  );
}
