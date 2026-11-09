"use client";

import { useState } from "react";
import { usePoll, useNow } from "../hooks/usePoll";
import { DEFAULT_RPC_URL } from "../lib/config";
import { config } from "../lib/env";
import { timeAgo } from "../lib/format";
import { KeeperError, keeper, type AttackResult, type LabAttack, type LabInfo } from "../lib/keeper";
import { nearblocksAccount, nearblocksTx } from "../lib/links";
import { calls, describePermission, judgeRefusal, rpc, viewResult, type AccessKeyInfo, type Judged, type TxStatus } from "../lib/verify";
import { Stamp } from "./Stamp";
import { Button, ButtonLink, Card, ExternalLink, Notice, PageHeader, Skeleton, cx } from "./ui";

const RPC = DEFAULT_RPC_URL.testnet;
const USDC_UNITS = 1_000_000;

type Shot =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "blocked"; message: string }
  | { status: "sent"; result: AttackResult; check: Judged | null | "unavailable" };

const usdc = (units: string | undefined) => (units === undefined ? null : (Number(units) / USDC_UNITS).toFixed(2));

/** Reads the transaction back from a public node, retrying while it's still settling. */
async function readBack(result: AttackResult, lab: LabInfo): Promise<Judged | "unavailable"> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const tx = await rpc<TxStatus>(RPC, calls.tx(result.txHash, lab.target.keeper));
      return judgeRefusal(tx, { keeper: lab.target.keeper, vault: lab.target.vault, panic: result.expected });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  return "unavailable";
}

function AttackCard({ attack, lab, onSent }: { attack: LabAttack; lab: LabInfo; onSent: () => void }) {
  const [shot, setShot] = useState<Shot>({ status: "idle" });
  const send = async () => {
    setShot({ status: "sending" });
    let result: AttackResult;
    try {
      result = await keeper.attack(config.simKeeperApiUrl, attack.id);
    } catch (error) {
      const message =
        error instanceof KeeperError && error.status === 502
          ? "NEAR testnet didn't answer in time, so it's unknown whether this one landed. It shows in the list below if it did."
          : error instanceof Error
            ? error.message
            : "The keeper didn't answer.";
      setShot({ status: "blocked", message });
      return;
    }
    setShot({ status: "sent", result, check: null });
    onSent();
    const check = await readBack(result, lab);
    setShot({ status: "sent", result, check });
  };

  const sent = shot.status === "sent" ? shot : null;
  return (
    <Card className="flex flex-col p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <h3 className="text-[19px] font-bold leading-snug text-ink">{attack.title}</h3>
        {sent ? <Stamp kind={sent.result.refused ? "refused" : "accepted"} /> : shot.status === "sending" ? <Stamp kind="sending" /> : null}
      </div>
      <p className="mt-2 flex-1 text-[14.5px] leading-relaxed text-body">{attack.move}</p>

      {sent ? (
        <div className="mt-4 rounded-md border-2 border-ink bg-paper px-3.5 py-3">
          <p className="font-readout text-[11px] uppercase tracking-[0.08em] text-muted">The vault answered, on chain</p>
          <p className={cx("mt-1 font-readout text-[13px] leading-snug", sent.result.refused ? "text-danger-ink" : "text-ink")}>{sent.result.answer}</p>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
            <ExternalLink href={nearblocksTx(sent.result.txHash, "testnet")}>The transaction</ExternalLink>
            <span className="text-muted">
              {sent.check === null
                ? "Reading it back from a public node…"
                : sent.check === "unavailable"
                  ? "The public node hasn't shown it yet; the link above will."
                  : sent.check.verdict === "proven"
                    ? "✓ Your browser read it back: signed by the lab keeper, refused by the vault itself."
                    : `Read back: ${sent.check.finding}`}
            </span>
          </p>
        </div>
      ) : shot.status === "blocked" ? (
        <Notice tone="warn" className="mt-4">
          {shot.message}
        </Notice>
      ) : null}

      <div className="mt-4">
        <Button variant={sent ? "secondary" : "primary"} busy={shot.status === "sending"} disabled={!lab.open} onClick={send}>
          {shot.status === "sending" ? "Sending to NEAR testnet…" : sent ? "Send it again" : "Send this attack"}
        </Button>
      </div>
    </Card>
  );
}

function Recent({ recent, attacks, now }: { recent: AttackResult[]; attacks: LabAttack[]; now: number }) {
  if (recent.length === 0) return <p className="text-[14px] text-muted">Nobody has tried yet. Be the first.</p>;
  return (
    <ol className="divide-y-2 divide-ink/10 overflow-hidden rounded-xl border-2 border-ink bg-card">
      {recent.map((r) => (
        <li key={r.txHash} className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[120px_220px_1fr_auto] sm:px-5">
          <time dateTime={r.at} className="order-2 font-readout text-[12px] text-muted sm:order-none">
            {timeAgo(r.at, now)}
          </time>
          <span className="order-1 text-[14.5px] font-semibold text-ink sm:order-none">{attacks.find((a) => a.id === r.id)?.title ?? r.id}</span>
          <span className="order-3 col-span-2 font-readout text-[12px] text-danger-ink sm:order-none sm:col-span-1">{r.refused ? r.answer : `ACCEPTED: ${r.answer}`}</span>
          <span className="order-4 text-[12.5px] sm:order-none">
            <ExternalLink href={nearblocksTx(r.txHash, "testnet")}>tx</ExternalLink>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Play the hacked keeper: real rescue calls with a keeper's real key, refused by the vault on testnet. */
export function AttackLabView() {
  const lab = usePoll("lab", () => keeper.lab(config.simKeeperApiUrl), 15_000);
  const info = lab.data;
  const target = info?.target;
  const reserve = usePoll(
    target ? `lab-reserve:${target.user}` : null,
    async () => viewResult<Record<string, string>>(await rpc(RPC, calls.view(target!.vault, "get_reserve", { user: target!.user }))),
    30_000,
  );
  const keys = usePoll(target ? `lab-keys:${target.keeper}` : null, async () => (await rpc<{ keys: AccessKeyInfo[] }>(RPC, calls.keys(target!.keeper))).keys, null);
  const now = useNow(5_000);
  const held = target ? usdc(reserve.data?.[target.token]) : null;

  return (
    <>
      <PageHeader eyebrow="Attack lab · NEAR testnet" title="Rob the vault">
        You&apos;re the hacked keeper. You hold a keeper&apos;s real key, the one a test user named to rescue them, so the vault takes your calls. Pick a trick: a real transaction
        goes to the testnet vault, the vault answers on chain, and your browser reads the answer back from a public node.
      </PageHeader>

      {lab.loading ? (
        <div className="grid gap-5 sm:grid-cols-2">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : !info ? (
        <Notice tone="warn" title="The lab isn't answering">
          {lab.error?.message ?? "The demo keeper didn't answer."} Every attack it has sent is still on chain; try again in a moment.
        </Notice>
      ) : (
        <>
          <div className="grid gap-5 sm:grid-cols-2">
            <Card className="p-5 sm:p-6">
              <p className="font-readout text-[11px] uppercase tracking-[0.08em] text-muted">The target</p>
              <p className="mt-2 text-[15px] text-body">
                <ExternalLink href={nearblocksAccount(info.target.user, "testnet")}>{info.target.user}</ExternalLink> keeps a reserve in the vault for rescues to their Hyperliquid
                address <span className="num break-all text-ink">{info.target.hlAddress}</span>, at most {usdc(info.target.maxPerRescue)} USDC at a time.
              </p>
              <p className="mt-4 flex items-baseline gap-2">
                <span className="num text-[38px] font-light leading-none text-ink">{held ?? (reserve.loading ? "…" : "?")}</span>
                <span className="text-[14px] text-muted">test USDC in the reserve, read from the chain{reserve.updatedAt ? ` ${timeAgo(new Date(reserve.updatedAt).toISOString(), now)}` : ""}</span>
              </p>
            </Card>
            <Card className="p-5 sm:p-6">
              <p className="font-readout text-[11px] uppercase tracking-[0.08em] text-muted">Your key</p>
              <p className="mt-2 text-[15px] text-body">
                <ExternalLink href={nearblocksAccount(info.target.keeper, "testnet")}>{info.target.keeper}</ExternalLink>, the keeper that user named. Its keys, read from the chain:
              </p>
              <ul className="mt-3 space-y-1.5 font-readout text-[12px] text-ink-2">
                {keys.data ? (
                  keys.data.map((key) => (
                    <li key={key.public_key} className="break-words [overflow-wrap:anywhere]">
                      {describePermission(key.access_key.permission)}
                    </li>
                  ))
                ) : (
                  <li>
                    <Skeleton className="h-4 w-3/4" />
                  </li>
                )}
              </ul>
              <p className="mt-3 text-[13px] leading-relaxed text-muted">Rescue only, like the real keeper&apos;s key: so a hacked keeper&apos;s only move is a rescue call. Here are the tricky ones.</p>
            </Card>
          </div>

          {!info.open ? (
            <Notice tone="danger" title="The lab is closed" className="mt-6">
              An attack got through, so the lab stopped and the team is looking at the vault. Every attack it sent is in the list below.
            </Notice>
          ) : null}

          <section aria-labelledby="attacks-title" className="mt-14">
            <h2 id="attacks-title" className="mb-5 text-[clamp(28px,3.4vw,44px)] font-extrabold uppercase leading-none text-ink [font-variation-settings:'wdth'_70]">
              Ways to try
            </h2>
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
              {info.attacks.map((attack) => (
                <AttackCard key={attack.id} attack={attack} lab={info} onSent={() => (lab.refresh(), reserve.refresh())} />
              ))}
            </div>
            <p className="mt-4 text-[13px] leading-relaxed text-muted">
              One attack every few seconds across everyone, so the lab can&apos;t be used to flood testnet. On testnet the vault trusts a stand-in quote key the team holds, because
              1Click has no testnet; the lab signs its quotes with it, so the vault reaches its later checks instead of stopping at the signature.
            </p>
          </section>

          <section aria-labelledby="recent-title" className="mt-14">
            <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="recent-title" className="text-[clamp(28px,3.4vw,44px)] font-extrabold uppercase leading-none text-ink [font-variation-settings:'wdth'_70]">
                Recent attempts
              </h2>
              <ButtonLink href="/verify" size="sm">
                Check the rest yourself →
              </ButtonLink>
            </div>
            <Recent recent={info.recent} attacks={info.attacks} now={now} />
          </section>
        </>
      )}
    </>
  );
}
