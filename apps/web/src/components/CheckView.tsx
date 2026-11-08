"use client";

import { POLICY_DEFAULTS } from "@lifeline/shared";
import type { HealthResult } from "@lifeline/hyperliquid";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { usePoll, useNow } from "../hooks/usePoll";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { formatHealth, formatPrice, formatUsd, timeAgo } from "../lib/format";
import { cushionUsd } from "../lib/gauge";
import { checkAddress } from "../lib/hl";
import { hyperliquidAddress } from "../lib/links";
import { Button, ButtonLink, Card, ExternalLink, Notice, PageHeader, Skeleton, Stat, cx, inputClass } from "./ui";
import { WatchScene } from "./art/Scenes";
import { Waterline, type WaterTone } from "./Waterline";

const REASONS: Record<Extract<HealthResult, { status: "unknown" }>["reason"], string> = {
  INVALID_ADDRESS: "That doesn't look like a Hyperliquid address: 0x and 40 hex characters.",
  API_ERROR: "Hyperliquid didn't answer. Try again in a moment.",
  MALFORMED_RESPONSE: "Hyperliquid's answer couldn't be read, so this account can't be treated as safe.",
  ISOLATED_ONLY: "This account only has isolated positions. A top-up adds cross margin, which can't protect them.",
  INCONSISTENT_MARGIN: "Hyperliquid reports open cross positions but no maintenance margin, so this reading can't be trusted.",
};

/** Any Hyperliquid account's health, live, drawn on the paper sea against Lifeline's default lines. */
export function CheckView() {
  const params = useSearchParams();
  const router = useRouter();
  const address = params.get("address")?.trim() ?? "";
  const [draft, setDraft] = useState(address);
  useEffect(() => setDraft(address), [address]);

  const reading = usePoll(address ? `check:${address}` : null, () => checkAddress(address), 10_000);
  const now = useNow(5_000);
  const reduced = useReducedMotion();
  const [ping, setPing] = useState(0);
  useEffect(() => {
    if (reading.updatedAt !== undefined) setPing((n) => n + 1);
  }, [reading.updatedAt]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = draft.trim();
    router.replace(value ? `/check?address=${encodeURIComponent(value)}` : "/check");
  };

  const result = reading.data;
  const ok = result?.status === "ok" ? result : null;
  const snapshot = ok?.snapshot ?? null;
  const levels = { warn: POLICY_DEFAULTS.warn, trigger: POLICY_DEFAULTS.trigger, target: POLICY_DEFAULTS.target };
  const health = snapshot && Number.isFinite(snapshot.health) ? snapshot.health : snapshot ? Number.POSITIVE_INFINITY : null;
  const tone: WaterTone =
    health === null ? "unknown" : health === Number.POSITIVE_INFINITY ? "none" : health <= 1 ? "liquidation" : health < levels.trigger ? "rescue" : health < levels.warn ? "warn" : "safe";
  const label = tone === "none" ? "No positions" : tone === "liquidation" ? "At liquidation" : tone === "rescue" ? "Lifeline would rescue" : tone === "warn" ? "Watch" : tone === "safe" ? "Safe" : "Unknown";

  return (
    <>
      <PageHeader eyebrow="Check any account" title="How close is liquidation?">
        Paste any Hyperliquid address. Lifeline reads its health live from Hyperliquid, the way the keeper does, and shows where its default lines would sit. Nothing
        to connect, nothing stored.
      </PageHeader>

      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor="check-address" className="sr-only">
          Hyperliquid address
        </label>
        <input
          id="check-address"
          className={cx(inputClass, "num sm:flex-1")}
          placeholder="0x… any Hyperliquid address"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoCapitalize="none"
          spellCheck={false}
        />
        <Button type="submit" variant="primary" size="lg">
          Check health
        </Button>
      </form>

      {!address ? (
        <div className="mt-8 grid grid-cols-1 items-center gap-6 overflow-hidden rounded-xl border-2 border-ink bg-[#e3ebff] sm:grid-cols-2">
          <div className="border-b-2 border-ink sm:border-b-0 sm:border-r-2">
            <WatchScene />
          </div>
          <div className="p-6">
            <p className="text-[20px] font-bold leading-snug text-ink">Paste an address to see its sea level.</p>
            <p className="mt-2 text-[14.5px] leading-relaxed text-body">
              Health is cross account value divided by maintenance margin, the number the keeper watches every 5 seconds. Here it refreshes every 10 seconds while
              the page is open.
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-5 lg:grid-cols-12">
          <Card className="overflow-hidden lg:col-span-7">
            <Waterline
              size="panel"
              className="relative h-[360px] sm:h-[400px]"
              health={tone === "unknown" ? null : health}
              levels={levels}
              tone={tone}
              throwSignal={0}
              pingSignal={ping}
              reduced={reduced}
              scaleTop={0.3}
              scaleMax={3}
              surface={
                <div className="absolute left-5 -translate-y-full pb-[60px] sm:left-6">
                  <p className="font-readout text-[clamp(48px,6vw,80px)] font-light leading-[0.9] tracking-[-0.05em] text-ink tabular-nums">
                    {health === null ? "—" : formatHealth(health)}
                  </p>
                  <p className={cx("mt-2 inline-block rounded-sm px-1.5 py-0.5 font-readout text-[11px] uppercase tracking-[0.1em]", TONE_CHIP[tone])}>Health · {label}</p>
                </div>
              }
            />
          </Card>

          <div className="flex flex-col gap-4 lg:col-span-5">
            {reading.loading ? (
              <Skeleton className="h-48" />
            ) : result && result.status === "unknown" ? (
              <Notice tone="warn" title="No trusted reading">
                {REASONS[result.reason]}
              </Notice>
            ) : snapshot ? (
              <Card className="p-5">
                <div className="grid grid-cols-2 gap-4">
                  <Stat label="Cross account value" value={formatUsd(snapshot.accountValue)} />
                  <Stat label="Maintenance margin" value={formatUsd(snapshot.maintenanceMarginUsed)} />
                  <Stat
                    label="Losses before a rescue"
                    value={tone === "none" ? "—" : formatUsd(Math.max(0, cushionUsd(snapshot, levels.trigger)))}
                    sub={`at health ${formatHealth(levels.trigger)}`}
                    tone="rescue"
                  />
                  <Stat label="Losses before liquidation" value={tone === "none" ? "—" : formatUsd(Math.max(0, cushionUsd(snapshot, 1)))} sub="at health 1.00" tone="danger" />
                </div>
                <p className="mt-4 border-t-2 border-ink/10 pt-3 font-readout text-[11.5px] text-muted">
                  Read {timeAgo(snapshot.at, now)} from Hyperliquid ·{" "}
                  <ExternalLink href={hyperliquidAddress(address)} className="text-ink">
                    open on Hyperliquid
                  </ExternalLink>
                </p>
              </Card>
            ) : null}
            {ok && ok.isolatedCoins.length > 0 ? (
              <Notice tone="warn" title="Isolated positions aren't covered">
                {ok.isolatedCoins.join(", ")} {ok.isolatedCoins.length === 1 ? "is" : "are"} isolated. A top-up adds cross margin, so Lifeline can't protect{" "}
                {ok.isolatedCoins.length === 1 ? "it" : "them"}.
              </Notice>
            ) : null}
            <div className="rounded-xl border-2 border-ink bg-sun p-5">
              <p className="text-[18px] font-bold leading-snug text-ink">Want Lifeline to watch this account?</p>
              <p className="mt-1.5 text-[14px] leading-relaxed text-ink">Set your own lines, fund a reserve from any chain, and the keeper tops it up before liquidation.</p>
              <ButtonLink href="/start" variant="secondary" className="mt-4">
                Protect this account
              </ButtonLink>
            </div>
          </div>

          {snapshot && snapshot.positions.length > 0 ? (
            <Card className="overflow-x-auto lg:col-span-12">
              <table className="w-full text-left text-[13px] sm:text-[14px]">
                <caption className="px-5 pt-5 text-left text-[17px] font-bold text-ink">Open positions</caption>
                <thead>
                  <tr className="font-readout text-[11px] uppercase tracking-[0.08em] text-muted">
                    <th className="px-3 py-3 font-normal sm:px-5">Coin</th>
                    <th className="px-3 py-3 font-normal sm:px-5">Side and size</th>
                    <th className="px-3 py-3 font-normal sm:px-5">Entry</th>
                    <th className="px-3 py-3 font-normal sm:px-5">Liquidation price</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.positions.map((p) => (
                    <tr key={p.coin} className="border-t-2 border-ink/10">
                      <td className="px-3 py-3 font-bold text-ink sm:px-5">{p.coin}</td>
                      <td className={cx("num px-3 py-3 sm:px-5", p.size >= 0 ? "text-safe-ink" : "text-danger-ink")}>
                        {p.size >= 0 ? "Long" : "Short"} {Math.abs(p.size)}
                      </td>
                      <td className="num px-3 py-3 text-ink sm:px-5">{formatPrice(p.entryPx)}</td>
                      <td className="num px-3 py-3 text-ink sm:px-5">{p.liquidationPx === null ? "none" : formatPrice(p.liquidationPx)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}

const TONE_CHIP: Record<WaterTone, string> = {
  safe: "bg-safe text-ink",
  warn: "bg-sun text-ink",
  rescue: "bg-rescue text-ink",
  liquidation: "bg-danger text-paper",
  none: "bg-shade text-ink",
  unknown: "bg-sun text-ink",
};
