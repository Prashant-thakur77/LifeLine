"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ASSETS, KEEPER_POLL_INTERVAL_SEC, POLICY_DEFAULTS, type HealthResponse } from "@lifeline/shared";
import { usePoll, useNow } from "../hooks/usePoll";
import { DEMO_USER } from "../lib/config";
import { config } from "../lib/env";
import { formatPrice, formatSeconds, formatUnits, formatUsd, parseUnits, shortMiddle, timeAgo } from "../lib/format";
import { SIM_STALE_AFTER_MS, STALE_AFTER_MS, classifyHealth, cushionUsd, rescueNeededUsd, type Reading } from "../lib/gauge";
import { KeeperError, keeper } from "../lib/keeper";
import { hyperliquidAddress, pageHref } from "../lib/links";
import { RpcError } from "../lib/near-rpc";
import { groupRecords, tokenMeta } from "../lib/records";
import { simRestCountdown } from "../lib/sim";
import { withdrawRefunded } from "../lib/tx";
import { pauseTx, tokenViews, unpauseTx, vaultViews, withdrawTx } from "../lib/vault";
import { EventList } from "./EventList";
import { GaugeLegend, HealthGauge } from "./HealthGauge";
import { TxStatus, useTx } from "./Tx";
import { AccountChooser, SimBanner, useIsSimulation, useViewedUser } from "./Viewing";
import { Badge, Button, ButtonLink, Card, CardHeader, ExternalLink, Field, inputClass, Notice, PageHeader, Skeleton, Stat, cx } from "./ui";
import { useWallet } from "./WalletProvider";

const POLL_MS = KEEPER_POLL_INTERVAL_SEC * 1000;

export function PositionView() {
  const { user } = useViewedUser();
  if (!user) {
    return (
      <>
        <PageHeader eyebrow="Position" title="Your position, watched every 5 seconds">
          Lifeline reads your Hyperliquid health, draws it against your own warn, trigger and target levels, and shows what the keeper will do next.
        </PageHeader>
        <AccountChooser path="/position" purpose="Connect the NEAR wallet you set your policy with, or type any account to see what the keeper sees." />
      </>
    );
  }
  return <Position key={user} user={user} />;
}

function Position({ user }: { user: string }) {
  const { simulation, keeperBase, info } = useIsSimulation(user);
  const health = usePoll(`health:${keeperBase}:${user}`, () => keeper.health(keeperBase, user), POLL_MS);
  const audit = usePoll(`audit:${keeperBase}:${user}`, () => keeper.audit(keeperBase, user, 30), 30_000);
  const now = useNow(1000);

  const notWatched = health.error instanceof KeeperError && health.error.kind === "not-watched";
  const reading = health.data ? classifyHealth(health.data, now, simulation ? SIM_STALE_AFTER_MS : STALE_AFTER_MS, health.updatedAt) : null;
  const restCountdown = simulation ? simRestCountdown(info?.nextAlarmAt, now) : null;
  const policy = health.data?.policy ?? null;
  const levels = policy ?? { warn: POLICY_DEFAULTS.warn, trigger: POLICY_DEFAULTS.trigger, target: POLICY_DEFAULTS.target };
  const events = useMemo(() => groupRecords(audit.data ?? []).slice(0, 3), [audit.data]);

  return (
    <>
      {simulation ? <SimBanner /> : null}
      <PageHeader
        eyebrow="Position"
        title={user}
        aside={
          policy ? (
            <div className="flex flex-col items-start gap-1 text-[13px] text-mist-400 sm:items-end">
              <span>Hyperliquid address</span>
              {simulation ? (
                <span className="num text-mist-200">{shortMiddle(policy.hlAddress)} (pretend)</span>
              ) : (
                <ExternalLink href={hyperliquidAddress(policy.hlAddress)} className="num text-mist-100">
                  {shortMiddle(policy.hlAddress)}
                </ExternalLink>
              )}
            </div>
          ) : null
        }
      >
        <LiveLine updatedAt={health.updatedAt} error={health.error} now={now} readingAt={health.data?.snapshot?.at ?? null} restCountdown={restCountdown} />
      </PageHeader>

      {notWatched ? (
        <Notice tone="warn" title="The keeper isn't watching this account" action={<ButtonLink href="/start" variant="primary">Set up protection</ButtonLink>}>
          {user === DEMO_USER
            ? "The sim keeper should always watch the demo account. It may be restarting; this page keeps checking."
            : "Either this account hasn't set a policy yet, or the keeper hasn't picked it up. Set a policy in the vault, then come back."}
        </Notice>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Card className="p-5 sm:p-6 lg:col-span-7">
            <GaugePanel reading={reading} loading={health.loading} levels={levels} error={health.error} />
          </Card>
          <div className="flex flex-col gap-4 lg:col-span-5">
            <MarginCard reading={reading} />
            <PolicyCard policy={policy} />
            <ReserveCard user={user} simulation={simulation} />
          </div>
          <Card className="lg:col-span-12">
            <PositionsTable response={health.data ?? null} simulation={simulation} />
          </Card>
          <Controls user={user} simulation={simulation} />
        </div>
      )}

      <section className="mt-10">
        <div className="mb-4 flex items-end justify-between gap-3">
          <h2 className="font-display text-[22px] text-paper">Recent activity</h2>
          <Link href={pageHref("/history", user)} className="text-[14px] text-mist-300 hover:text-paper">
            Full history →
          </Link>
        </div>
        {audit.loading ? (
          <Skeleton className="h-28" />
        ) : audit.error && !audit.data ? (
          <Notice tone="danger" title="Couldn't load the activity">{audit.error.message}</Notice>
        ) : events.length === 0 ? (
          <Notice tone="info" title="Nothing yet">No warnings or rescues for this account so far.</Notice>
        ) : (
          <EventList events={events} />
        )}
      </section>
    </>
  );
}

function LiveLine({
  updatedAt,
  error,
  now,
  readingAt,
  restCountdown,
}: {
  updatedAt: number | undefined;
  error: Error | undefined;
  now: number;
  readingAt: string | null;
  restCountdown: string | null;
}) {
  if (error && updatedAt === undefined && !(error instanceof KeeperError && error.kind === "not-watched")) {
    return <span className="text-[#ff8a98]">{error.message}</span>;
  }
  if (updatedAt === undefined) return <span className="text-mist-400">Connecting to the keeper…</span>;
  const age = timeAgo(new Date(updatedAt).toISOString(), now);
  const readingAge = readingAt ? timeAgo(readingAt, now) : null;
  return (
    <span className="flex flex-col gap-1 text-[14px]">
      <span className="inline-flex items-center gap-2">
        <span className={cx("size-2 shrink-0 rounded-full", error ? "bg-warn" : "bg-safe animate-pulse-soft")} aria-hidden />
        {error
          ? `Keeper unreachable, last answer ${age}. Retrying.`
          : `Live from the keeper, asked every ${KEEPER_POLL_INTERVAL_SEC} s. Reading taken ${readingAge ?? "—"}.`}
      </span>
      {restCountdown ? (
        <span className="text-sim">
          The sim keeper is resting between price drops, so this reading holds still. Next drop in <span className="num">{restCountdown}</span>.
        </span>
      ) : null}
    </span>
  );
}

function GaugePanel({ reading, loading, levels, error }: { reading: Reading | null; loading: boolean; levels: { warn: number; trigger: number; target: number }; error: Error | undefined }) {
  return (
    <div className="flex flex-col gap-5">
      <HealthGauge reading={loading ? null : reading} levels={levels} />
      <GaugeLegend levels={levels} />
      {reading ? (
        <Notice
          tone={
            reading.zone === "safe"
              ? "safe"
              : reading.zone === "warn" || reading.zone === "unknown" || reading.zone === "stale"
                ? "warn"
                : reading.zone === "none"
                  ? "info"
                  : "rescue"
          }
          title={reading.headline}
        >
          {reading.detail}
        </Notice>
      ) : loading ? (
        <Skeleton className="h-14" />
      ) : error ? (
        <Notice tone="warn" title="Unknown">
          No reading yet: {error.message} Don&apos;t treat this account as safe.
        </Notice>
      ) : null}
    </div>
  );
}

function MarginCard({ reading }: { reading: Reading | null }) {
  const snapshot = reading?.snapshot ?? null;
  const policy = reading?.policy ?? null;
  const trusted = reading !== null && reading.zone !== "unknown" && reading.zone !== "stale";
  return (
    <Card>
      <CardHeader eyebrow="Cross margin" title="Margin" />
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 p-5">
        {snapshot ? (
          <>
            <Stat label="Account value" value={formatUsd(snapshot.accountValue)} />
            <Stat label="Maintenance margin" value={formatUsd(snapshot.maintenanceMarginUsed)} />
            {trusted && policy && reading.zone !== "none" ? (
              <>
                <Stat
                  label="Losses until rescue"
                  value={cushionUsd(snapshot, policy.trigger) > 0 ? formatUsd(cushionUsd(snapshot, policy.trigger)) : "Now"}
                  tone={cushionUsd(snapshot, policy.trigger) > 0 ? undefined : "rescue"}
                />
                <Stat
                  label="Losses until liquidation"
                  value={cushionUsd(snapshot, 1) > 0 ? formatUsd(cushionUsd(snapshot, 1)) : "Now"}
                  tone={cushionUsd(snapshot, 1) > 0 ? undefined : "danger"}
                />
                {reading.zone === "rescue" || reading.zone === "liquidation" ? (
                  <div className="col-span-2">
                    <Stat label={`To reach ${policy.target.toFixed(2)}, before fees`} value={formatUsd(rescueNeededUsd(snapshot, policy.target))} tone="rescue" />
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        ) : (
          <>
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </>
        )}
      </div>
    </Card>
  );
}

function PolicyCard({ policy }: { policy: HealthResponse["policy"] | null }) {
  return (
    <Card>
      <CardHeader eyebrow="As the keeper reads it" title="Policy" action={policy?.paused ? <Badge tone="warn">Paused</Badge> : policy ? <Badge tone="safe">Active</Badge> : null} />
      {policy ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-5 text-[14px]">
          <dt className="text-mist-400">Per rescue, at most</dt>
          <dd className="num text-right text-mist-100">{formatUnits(policy.maxPerRescue, ASSETS.NEAR_USDC.decimals)} USDC</dd>
          <dt className="text-mist-400">Per 24 hours, at most</dt>
          <dd className="num text-right text-mist-100">{formatUnits(policy.maxPerDay, ASSETS.NEAR_USDC.decimals)} USDC</dd>
          <dt className="text-mist-400">Cooldown</dt>
          <dd className="num text-right text-mist-100">{formatSeconds(policy.cooldownSec)}</dd>
        </dl>
      ) : (
        <div className="p-5">
          <Skeleton className="h-16" />
        </div>
      )}
    </Card>
  );
}

function ReserveCard({ user, simulation }: { user: string; simulation: boolean }) {
  const vault = config.vaultId;
  const reserve = usePoll(vault && !simulation ? `reserve:${vault}:${user}` : null, () => vaultViews.reserve(config.rpcUrl, vault!, user), 15_000);
  return (
    <Card>
      <CardHeader eyebrow="In the vault" title="Reserve" action={vault && !simulation ? <Link href="/fund" className="text-[13px] text-mist-300 hover:text-paper">Add funds →</Link> : null} />
      <div className="p-5 text-[14px]">
        {simulation ? (
          <p className="text-mist-300">The demo account has no on-chain reserve: the sim keeper pretends it has enough for every rescue.</p>
        ) : !vault ? (
          <p className="text-mist-300">The vault isn&apos;t deployed yet, so there&apos;s no reserve to read. Health and history above still work.</p>
        ) : reserve.loading ? (
          <Skeleton className="h-10" />
        ) : reserve.error ? (
          <p className="text-[#ff8a98]">{reserve.error instanceof RpcError ? reserve.error.message : "Couldn't read the vault."}</p>
        ) : Object.keys(reserve.data ?? {}).length === 0 ? (
          <p className="text-mist-300">Empty. Fund it so the keeper has something to rescue with.</p>
        ) : (
          <ul className="space-y-2">
            {Object.entries(reserve.data ?? {}).map(([token, amount]) => {
              const meta = tokenMeta(token, config.usdcContractId);
              return (
                <li key={token} className="flex items-baseline justify-between gap-3">
                  <span className="text-mist-300">{meta.symbol.length > 12 ? shortMiddle(meta.symbol) : meta.symbol}</span>
                  <span className="num text-[18px] text-paper">{formatUnits(amount, meta.decimals)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

function PositionsTable({ response, simulation }: { response: HealthResponse | null; simulation: boolean }) {
  const positions = response?.snapshot?.positions ?? null;
  return (
    <div>
      <CardHeader eyebrow={simulation ? "Simulated" : "Hyperliquid"} title="Open positions" />
      {positions === null ? (
        <div className="p-5">
          {response?.status === "unknown" ? (
            <p className="text-[14px] text-mist-300">Hyperliquid couldn&apos;t be read, so positions are unknown.</p>
          ) : (
            <Skeleton className="h-16" />
          )}
        </div>
      ) : positions.length === 0 ? (
        <p className="p-5 text-[14px] text-mist-300">No open positions.</p>
      ) : (
        <div className="overflow-x-auto px-1 pb-3 sm:px-3">
          <table className="w-full min-w-[340px] text-left text-[14px]">
            <thead>
              <tr className="text-[12px] uppercase tracking-[0.08em] text-mist-400">
                <th className="px-2 py-3 sm:px-3 font-medium">Coin</th>
                <th className="px-2 py-3 sm:px-3 text-right font-medium">Size</th>
                <th className="px-2 py-3 sm:px-3 text-right font-medium">Entry</th>
                <th className="px-2 py-3 sm:px-3 text-right font-medium">Liquidation</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.coin} className="border-t border-ink-600/60">
                  <td className="px-2 py-3 sm:px-3">
                    <span className="font-semibold text-paper">{p.coin}</span>{" "}
                    <span className={cx("text-[12px] font-semibold uppercase tracking-[0.06em]", p.size >= 0 ? "text-safe" : "text-[#ff8a98]")}>
                      {p.size >= 0 ? "long" : "short"}
                    </span>
                  </td>
                  <td className="num px-2 py-3 sm:px-3 text-right text-mist-100">{formatPrice(Math.abs(p.size))}</td>
                  <td className="num px-2 py-3 sm:px-3 text-right text-mist-100">{formatPrice(p.entryPx)}</td>
                  <td className="num px-2 py-3 sm:px-3 text-right text-rescue">{p.liquidationPx === null ? <span className="text-mist-400">none near</span> : formatPrice(p.liquidationPx)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Pause, unpause and withdraw, for the account's owner only. */
function Controls({ user, simulation }: { user: string; simulation: boolean }) {
  const { accountId } = useWallet();
  const vault = config.vaultId;
  const isOwner = accountId === user;
  const chainPolicy = usePoll(vault && isOwner && !simulation ? `policy:${vault}:${user}` : null, () => vaultViews.policy(config.rpcUrl, vault!, user), 15_000);
  const reserve = usePoll(vault && isOwner && !simulation ? `reserve-ctl:${vault}:${user}` : null, () => vaultViews.reserve(config.rpcUrl, vault!, user), 15_000);
  const pause = useTx();
  const withdraw = useTx();
  const [amount, setAmount] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);

  if (simulation || !isOwner) return null;

  const usdc = config.usdcContractId;
  const balance = reserve.data?.[usdc] ?? "0";
  const paused = chainPolicy.data?.paused ?? false;

  return (
    <Card className="lg:col-span-12">
      <CardHeader eyebrow="Only you can do these" title="Controls" />
      <div className="grid gap-6 p-5 md:grid-cols-2">
        {!vault ? (
          <p className="text-[14px] text-mist-300 md:col-span-2">The vault isn&apos;t deployed yet, so there&apos;s nothing to pause or withdraw from.</p>
        ) : chainPolicy.loading ? (
          <Skeleton className="h-24 md:col-span-2" />
        ) : chainPolicy.error && chainPolicy.data === undefined ? (
          <Notice tone="danger" title="Couldn't read your policy from the vault" className="md:col-span-2">
            {chainPolicy.error.message} Pause and withdraw stay hidden until it can be read, so they never act on a guess.
          </Notice>
        ) : chainPolicy.data === null ? (
          <Notice tone="info" title="No policy in the vault yet" action={<ButtonLink href="/start" variant="primary">Set up protection</ButtonLink>} className="md:col-span-2">
            Set a policy first. Then you can fund the reserve, pause and withdraw here.
          </Notice>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <h3 className="text-[14px] font-semibold text-paper">{paused ? "Rescues are paused" : "Rescues are on"}</h3>
              <p className="text-[14px] leading-relaxed text-mist-300">
                {paused
                  ? "The vault refuses every rescue until you unpause. Unpausing needs your wallet's full-access key."
                  : "Pausing takes effect at once and attaches no deposit. The vault refuses every rescue until you unpause."}
              </p>
              <Button
                variant={paused ? "primary" : "danger"}
                className="self-start"
                busy={pause.busy}
                onClick={async () => {
                  if (await pause.run(paused ? unpauseTx(vault) : pauseTx(vault))) chainPolicy.refresh();
                }}
              >
                {paused ? "Unpause rescues" : "Pause rescues"}
              </Button>
              <TxStatus state={pause.state} doneTitle={paused ? "Paused" : "Done"} />
            </div>
            <form
              className="flex flex-col gap-3"
              onSubmit={async (event) => {
                event.preventDefault();
                const parsed = parseUnits(amount, ASSETS.NEAR_USDC.decimals);
                if (!parsed.ok) return setAmountError(parsed.error);
                if (BigInt(parsed.base) === 0n) return setAmountError("Enter an amount above 0.");
                if (BigInt(parsed.base) > BigInt(balance)) return setAmountError("That's more than your reserve holds.");
                const ok = await withdraw.run(
                  withdrawTx(vault, usdc, parsed.base),
                  (outcome) => (withdrawRefunded(outcome) ? "USDC refused the transfer, so the vault put the amount back in your reserve." : null),
                  "The USDC is back in your NEAR account.",
                );
                reserve.refresh();
                if (ok) {
                  setAmount("");
                  reserve.refresh();
                }
              }}
            >
              <h3 className="text-[14px] font-semibold text-paper">Withdraw USDC</h3>
              <Field
                label={`Amount (reserve holds ${formatUnits(balance, ASSETS.NEAR_USDC.decimals)} USDC)`}
                htmlFor="withdraw-amount"
                error={amountError}
                hint="Goes back to your own NEAR account, any time."
              >
                <div className="flex gap-2">
                  <input
                    id="withdraw-amount"
                    inputMode="decimal"
                    className={inputClass}
                    placeholder="0.00"
                    value={amount}
                    aria-invalid={amountError ? true : undefined}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setAmountError(null);
                    }}
                  />
                  <Button variant="ghost" className="h-11" onClick={() => setAmount(formatUnits(balance, ASSETS.NEAR_USDC.decimals, ASSETS.NEAR_USDC.decimals).replace(/,/g, ""))}>
                    Max
                  </Button>
                </div>
              </Field>
              <Button type="submit" variant="secondary" className="self-start" busy={withdraw.busy}>
                Withdraw
              </Button>
              <TxStatus state={withdraw.state} doneTitle="Withdrawn" />
            </form>
          </>
        )}
      </div>
      <TokenBalanceNote user={user} />
    </Card>
  );
}

/** A quiet line with the wallet's own USDC, so withdrawing visibly lands somewhere. */
function TokenBalanceNote({ user }: { user: string }) {
  const balance = usePoll(`bal:${config.usdcContractId}:${user}`, () => tokenViews.balance(config.rpcUrl, config.usdcContractId, user), 30_000);
  if (balance.data === undefined) return null;
  return (
    <p className="border-t border-ink-600/60 px-5 py-3 text-[13px] text-mist-400">
      Your NEAR account holds <span className="num text-mist-200">{formatUnits(balance.data, ASSETS.NEAR_USDC.decimals)} USDC</span> outside the vault.
    </p>
  );
}
