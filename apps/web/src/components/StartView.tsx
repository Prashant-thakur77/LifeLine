"use client";

import { useEffect, useState, type ReactNode } from "react";
import { POLICY_RANGES } from "@lifeline/shared";
import { usePoll } from "../hooks/usePoll";
import { config } from "../lib/env";
import { formatHealth, formatSeconds } from "../lib/format";
import { healthToFraction } from "../lib/gauge";
import { hyperliquidAddress, nearblocksAccount, pageHref } from "../lib/links";
import { PRESETS, draftFromVault, matchPreset, presetDraft, validatePolicy, type PolicyDraft, type PresetId } from "../lib/policy";
import { describeTxError } from "../lib/tx";
import { setPolicyTx, vaultViews } from "../lib/vault";
import { isHlAddress } from "../lib/accounts";
import { TxStatus, useTx } from "./Tx";
import { Badge, Button, ButtonLink, Card, ExternalLink, Field, inputClass, Notice, PageHeader, cx } from "./ui";
import { useWallet } from "./WalletProvider";

type Choice = PresetId | "custom";

export function StartView() {
  const { status, accountId, connect } = useWallet();
  const [connectError, setConnectError] = useState<string | null>(null);

  return (
    <>
      <PageHeader eyebrow="Set up protection" title="Draw your lines">
        Four steps: connect, tell Lifeline which Hyperliquid account to protect, choose when it acts, and sign the policy into the vault. You can change it
        or pause at any time.
      </PageHeader>

      {!config.vaultId ? (
        <Notice tone="info" title="The mainnet vault opens soon" className="mb-6">
          Fill this in and see exactly what you&apos;ll sign when the mainnet vault opens. Meanwhile, the{" "}
          <a href={pageHref("/position", "demo.near")}>live demo</a> shows the whole thing working.
        </Notice>
      ) : null}

      <ol className="relative flex flex-col gap-4 before:absolute before:bottom-6 before:left-[19px] before:top-6 before:w-px before:bg-shade sm:before:left-[23px]">
        <Step n={1} title="Connect your NEAR wallet" done={accountId !== null}>
          {accountId ? (
            <p className="text-[14.5px] text-ink-2">
              Connected as <span className="font-semibold text-ink">{accountId}</span>. The policy is stored under this account, and only it can change or
              withdraw.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-[14.5px] text-body">The account that owns the reserve and the policy. Any NEAR wallet works.</p>
              <Button
                variant="primary"
                className="self-start"
                disabled={status !== "ready"}
                onClick={async () => {
                  setConnectError(null);
                  try {
                    await connect();
                  } catch (e) {
                    setConnectError(describeTxError(e));
                  }
                }}
              >
                Connect wallet
              </Button>
              {status === "unavailable" ? <p className="text-[13px] text-danger-ink">The wallet connector couldn&apos;t load. Reload the page to try again.</p> : null}
              {connectError ? <p className="text-[13px] text-danger-ink">{connectError}</p> : null}
            </div>
          )}
        </Step>
        {/* Not keyed by account: what someone typed before connecting survives the connect. */}
        <PolicyForm accountId={accountId} />
      </ol>
    </>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children?: ReactNode }) {
  return (
    <li className="relative pl-12 sm:pl-14">
      <span
        className={cx(
          "num absolute left-0 top-4 grid size-10 place-items-center rounded-full border-2 border-ink text-[15px] font-semibold sm:size-12",
          done ? "bg-safe text-ink" : "bg-sun text-ink",
        )}
        aria-hidden
      >
        {done ? "✓" : n}
      </span>
      <Card className="p-5 sm:p-6">
        <h2 className="text-[16px] font-semibold text-ink">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h2>
        {children ? <div className="mt-3">{children}</div> : null}
      </Card>
    </li>
  );
}

/** Anyone can fill this in and see exactly what would be signed; signing needs the wallet. */
function PolicyForm({ accountId }: { accountId: string | null }) {
  const vault = config.vaultId;
  const existing = usePoll(vault && accountId ? `policy:${vault}:${accountId}` : null, () => vaultViews.policy(config.rpcUrl, vault!, accountId!), null);
  const [draft, setDraft] = useState<PolicyDraft>(() => presetDraft("standard"));
  const [choice, setChoice] = useState<Choice>("standard");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const tx = useTx();

  // A returning user edits what they already have: once per account, so a later
  // refresh of the same policy doesn't overwrite their edits.
  useEffect(() => {
    if (!existing.data || !accountId || loadedFor === accountId) return;
    const loaded = draftFromVault(existing.data);
    setDraft(loaded);
    setChoice(matchPreset(Number(loaded.warn), Number(loaded.trigger), Number(loaded.target)));
    setLoadedFor(accountId);
  }, [existing.data, accountId, loadedFor]);

  const check = validatePolicy(draft, config.keeperAccountId);
  const errors = check.ok ? {} : check.errors;
  const show = (field: keyof PolicyDraft) => (attempted || draft[field] !== "" ? errors[field] ?? null : null);
  const set = (field: keyof PolicyDraft) => (value: string) => setDraft((d) => ({ ...d, [field]: value }));
  const firstTime = !existing.data;
  const hlOk = isHlAddress(draft.hlAddress.trim());

  const choose = (id: Choice) => {
    setChoice(id);
    if (id !== "custom") {
      const preset = presetDraft(id);
      setDraft((d) => ({ ...d, warn: preset.warn, trigger: preset.trigger, target: preset.target }));
    }
  };

  const blockers: string[] = [];
  if (!accountId) blockers.push("Connect a wallet first (step 1).");
  if (!vault) blockers.push("The mainnet vault opens soon.");
  else if (accountId && existing.loading) blockers.push("Reading your current policy from the vault…");
  else if (existing.error) blockers.push(`Couldn't read the vault: ${existing.error.message}`);
  if (!config.keeperAccountId) blockers.push("No keeper account is configured for this dashboard.");

  return (
    <>
      <Step n={2} title="Your Hyperliquid address" done={hlOk}>
        <Field
          label="The address you trade with on Hyperliquid"
          htmlFor="hl-address"
          error={show("hlAddress")}
          hint="Rescues can only ever be paid to this address: the vault checks it on every one."
        >
          <input
            id="hl-address"
            className={cx(inputClass, "num")}
            placeholder="0x…"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={draft.hlAddress}
            aria-invalid={show("hlAddress") ? true : undefined}
            onChange={(e) => set("hlAddress")(e.target.value)}
          />
        </Field>
        {hlOk ? (
          <p className="mt-2 text-[13px] text-muted">
            <ExternalLink href={hyperliquidAddress(draft.hlAddress.trim())}>Check this address on Hyperliquid</ExternalLink> before you sign. Health covers
            cross margin only; isolated positions can&apos;t be topped up.
          </p>
        ) : null}
      </Step>

      <Step n={3} title="When Lifeline acts" done={!errors.warn && !errors.trigger && !errors.target}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          {PRESETS.map((preset) => (
            <PresetCard key={preset.id} selected={choice === preset.id} onSelect={() => choose(preset.id)} title={preset.label} blurb={preset.blurb}>
              <ScaleBar warn={preset.warn} trigger={preset.trigger} target={preset.target} />
            </PresetCard>
          ))}
          <PresetCard selected={choice === "custom"} onSelect={() => choose("custom")} title="Custom" blurb="Set each level yourself, inside the vault's ranges." />
        </div>

        {choice === "custom" ? (
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Warn below" htmlFor="warn" error={show("warn")} hint={`${POLICY_RANGES.warn.min} to ${POLICY_RANGES.warn.max.toFixed(1)}. A Telegram alert, nothing more.`}>
              <input id="warn" inputMode="decimal" className={cx(inputClass, "num")} value={draft.warn} onChange={(e) => set("warn")(e.target.value)} aria-invalid={show("warn") ? true : undefined} />
            </Field>
            <Field label="Rescue below" htmlFor="trigger" error={show("trigger")} hint={`${POLICY_RANGES.trigger.min} to ${POLICY_RANGES.trigger.max}, below warn.`}>
              <input id="trigger" inputMode="decimal" className={cx(inputClass, "num")} value={draft.trigger} onChange={(e) => set("trigger")(e.target.value)} aria-invalid={show("trigger") ? true : undefined} />
            </Field>
            <Field label="Refill to" htmlFor="target" error={show("target")} hint={`Above the trigger, up to ${POLICY_RANGES.target.max.toFixed(1)}.`}>
              <input id="target" inputMode="decimal" className={cx(inputClass, "num")} value={draft.target} onChange={(e) => set("target")(e.target.value)} aria-invalid={show("target") ? true : undefined} />
            </Field>
            {check.ok || (!errors.warn && !errors.trigger && !errors.target) ? (
              <div className="sm:col-span-3">
                <ScaleBar warn={Number(draft.warn)} trigger={Number(draft.trigger)} target={Number(draft.target)} large />
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 border-t-2 border-ink/10 pt-5">
          <h3 className="text-[14px] font-semibold text-ink">Limits</h3>
          <p className="mt-1 text-[13.5px] text-muted">The vault enforces these on every rescue, whatever the keeper asks for.</p>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Most per rescue (USDC)" htmlFor="per-rescue" error={show("maxPerRescueUsdc")} hint="At least 2: 1Click won't send less to Hyperliquid.">
              <input id="per-rescue" inputMode="decimal" className={cx(inputClass, "num")} value={draft.maxPerRescueUsdc} onChange={(e) => set("maxPerRescueUsdc")(e.target.value)} aria-invalid={show("maxPerRescueUsdc") ? true : undefined} />
            </Field>
            <Field label="Most per 24 hours (USDC)" htmlFor="per-day" error={show("maxPerDayUsdc")} hint="At least the cap per rescue.">
              <input id="per-day" inputMode="decimal" className={cx(inputClass, "num")} value={draft.maxPerDayUsdc} onChange={(e) => set("maxPerDayUsdc")(e.target.value)} aria-invalid={show("maxPerDayUsdc") ? true : undefined} />
            </Field>
            <Field label="Cooldown (seconds)" htmlFor="cooldown" error={show("cooldownSec")} hint={`${POLICY_RANGES.cooldownSec.min} to ${POLICY_RANGES.cooldownSec.max.toLocaleString("en-US")} between rescues.`}>
              <input id="cooldown" inputMode="numeric" className={cx(inputClass, "num")} value={draft.cooldownSec} onChange={(e) => set("cooldownSec")(e.target.value)} aria-invalid={show("cooldownSec") ? true : undefined} />
            </Field>
          </div>
        </div>
      </Step>

      <Step n={4} title={firstTime ? "Sign the policy" : "Update your policy"} done={tx.state.phase === "done"}>
        {existing.data ? (
          <Notice tone="info" title="You already have a policy" className="mb-4">
            The form starts from it. Signing again replaces it and keeps your paused setting{existing.data.paused ? " (currently paused)" : ""}.
          </Notice>
        ) : null}
        <Summary draft={draft} ok={check.ok} />
        <div className="mt-5 flex flex-col gap-3">
          {blockers.length > 0 ? (
            <ul className="space-y-1 text-[13.5px] text-body">
              {blockers.map((b) => (
                <li key={b}>· {b}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-[13.5px] leading-relaxed text-muted">
            {firstTime
              ? "The first policy attaches 0.05 NEAR for your storage in the vault; anything over what's needed comes back."
              : "Changing a policy attaches 1 yoctoNEAR, which only a full-access key can do, so your wallet always asks you to confirm."}{" "}
            The keeper named here is the only account that can ask the vault for a rescue:{" "}
            {config.keeperAccountId ? (
              <ExternalLink href={nearblocksAccount(config.keeperAccountId, config.network)} className="num text-ink-2">
                {config.keeperAccountId}
              </ExternalLink>
            ) : (
              "not configured yet"
            )}
            .
          </p>
          <Button
            variant="primary"
            size="lg"
            className="self-start"
            busy={tx.busy}
            disabled={blockers.length > 0}
            onClick={async () => {
              setAttempted(true);
              if (!check.ok || !vault) return;
              if (await tx.run(setPolicyTx(vault, check.policy, firstTime))) existing.refresh();
            }}
          >
            {firstTime ? "Sign and save policy" : "Sign and update policy"}
          </Button>
          {attempted && !check.ok ? <p className="text-[13.5px] text-danger-ink">Fix the fields marked above first.</p> : null}
          <TxStatus state={tx.state} doneTitle="Policy saved in the vault" />
          {tx.state.phase === "done" ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <ButtonLink href="/fund" variant="primary">
                Next: fund your reserve
              </ButtonLink>
              <ButtonLink href={pageHref("/position", accountId)}>Watch my position</ButtonLink>
              <ButtonLink href="/telegram" variant="ghost">
                Get Telegram alerts
              </ButtonLink>
            </div>
          ) : null}
        </div>
      </Step>
    </>
  );
}

function PresetCard({ selected, onSelect, title, blurb, children }: { selected: boolean; onSelect: () => void; title: string; blurb: string; children?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(
        "flex flex-col gap-2 rounded-2xl border p-4 text-left transition-colors",
        selected ? "border-ink bg-[#ffe1d4] shadow-[3px_3px_0_var(--color-ink)]" : "border-ink/30 bg-card hover:border-ink",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-[15px] font-semibold text-ink">{title}</span>
        {selected ? <Badge tone="rescue">Chosen</Badge> : null}
      </span>
      <span className="text-[13px] leading-relaxed text-body">{blurb}</span>
      {children}
    </button>
  );
}

/** The three levels on the gauge's own scale, flattened into a bar. */
function ScaleBar({ warn, trigger, target, large = false }: { warn: number; trigger: number; target: number; large?: boolean }) {
  const pct = (h: number) => `${(healthToFraction(h) * 100).toFixed(2)}%`;
  return (
    <div className={cx("mt-auto", large ? "pt-2" : "pt-3")} aria-label={`Warn ${warn}, rescue below ${trigger}, refill to ${target}`}>
      <div className="relative h-2 overflow-hidden rounded-full bg-shade">
        <div className="absolute inset-y-0 left-0 bg-rescue/50" style={{ width: pct(trigger) }} />
        <div className="absolute inset-y-0 bg-warn/45" style={{ left: pct(trigger), width: `calc(${pct(warn)} - ${pct(trigger)})` }} />
        <div className="absolute inset-y-0 right-0 bg-safe/35" style={{ left: pct(warn) }} />
        <div className="absolute inset-y-[-2px] w-[2px] bg-safe" style={{ left: pct(target) }} />
      </div>
      <div className="num mt-1.5 flex justify-between text-[11.5px]">
        <span className="text-rescue-ink">↓{formatHealth(trigger)}</span>
        <span className="text-warn-ink">{formatHealth(warn)}</span>
        <span className="text-safe-ink">→{formatHealth(target)}</span>
      </div>
    </div>
  );
}

function Summary({ draft, ok }: { draft: PolicyDraft; ok: boolean }) {
  const rows: [string, ReactNode][] = [
    ["Hyperliquid address", <span key="a" className="num break-all">{draft.hlAddress.trim() || "—"}</span>],
    ["Warn below", formatHealth(Number(draft.warn))],
    ["Rescue below", formatHealth(Number(draft.trigger))],
    ["Refill to", formatHealth(Number(draft.target))],
    ["Most per rescue", `${draft.maxPerRescueUsdc || "—"} USDC`],
    ["Most per 24 hours", `${draft.maxPerDayUsdc || "—"} USDC`],
    ["Cooldown", /^\d+$/.test(draft.cooldownSec) ? formatSeconds(Number(draft.cooldownSec)) : "—"],
  ];
  return (
    <dl className={cx("grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg border-2 bg-card p-4 text-[14px]", ok ? "border-ink" : "border-ink/30 opacity-80")}>
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="num text-right text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
