"use client";

import { nearblocksTx } from "../lib/links";
import { REFUSED_RESCUE } from "../lib/proof";
import { cx } from "./ui";

/** The vault refusing a hacked keeper on chain, printed as a ticket. */
export function RefusalReceipt({ className }: { className?: string }) {
  const r = REFUSED_RESCUE;
  return (
    <figure className={cx("rounded-md border-2 border-ink bg-paper text-ink shadow-[0_18px_30px_-18px_rgb(11_21_51/0.8)]", className)}>
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
