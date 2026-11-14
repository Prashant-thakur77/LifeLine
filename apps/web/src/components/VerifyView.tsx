"use client";

import type { AttestationResponse } from "@lifeline/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  checkKeyLive,
  checkProofOffline,
  ledgerShows,
  loadIntel,
  randomNonce,
  type LiveCheck,
  type OfflineCheck,
  type ProvedRecord,
  type Step,
} from "../lib/answer-proof";
import { DEMO_USER, keeperUrlFor } from "../lib/config";
import { config } from "../lib/env";
import { timeAgo } from "../lib/format";
import { KeeperError, keeper } from "../lib/keeper";
import { nearblocksAccount, nearblocksTx, pageHref } from "../lib/links";
import { RpcError } from "../lib/near-rpc";
import {
  DEPLOYMENTS,
  calls,
  curlFor,
  judgeKeeperKeys,
  judgeRefusal,
  judgeVaultCode,
  judgeVaultConfig,
  judgeVaultKeys,
  rpc,
  viewResult,
  type AccessKeyInfo,
  type AccountView,
  type Deployment,
  type Judged,
  type RpcCall,
  type SourceMetadata,
  type TxStatus,
  type Verdict,
  type VaultConfig,
} from "../lib/verify";
import { Stamp, type StampKind } from "./Stamp";
import { Button, Card, CopyButton, ExternalLink, Notice, PageHeader, Skeleton, cx } from "./ui";

/** A claim's state for the summary: settled (a verdict, or no answer) or still checking; "nothing to check" leaves the count. */
type Reported = Verdict | "error" | "checking" | "nothing to check";
type Report = (key: string, state: Reported) => void;

type Outcome = { status: "checking" } | { status: "done"; judged: Judged } | { status: "error"; message: string };

const message = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");
const reported = (outcome: Outcome): Reported => (outcome.status === "done" ? outcome.judged.verdict : outcome.status);

/** Runs `work` on mount and again whenever `run` changes. */
function useCheck(work: () => Promise<Judged>, run: number): Outcome {
  const [outcome, setOutcome] = useState<Outcome>({ status: "checking" });
  // The work for a card never changes; `run` is what asks for it again.
  const stable = useCallback(work, []);
  useEffect(() => {
    let live = true;
    setOutcome({ status: "checking" });
    stable().then(
      (judged) => live && setOutcome({ status: "done", judged }),
      (error: unknown) => live && setOutcome({ status: "error", message: message(error) }),
    );
    return () => {
      live = false;
    };
  }, [run, stable]);
  return outcome;
}

function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group/d mt-4 border-t-2 border-dashed border-ink/15 pt-3">
      <summary className="cursor-pointer list-none text-[13px] font-semibold text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        <span className="mr-1.5 inline-block transition-transform group-open/d:rotate-90" aria-hidden>
          ›
        </span>
        {summary}
      </summary>
      {children}
    </details>
  );
}

/** What the browser sent, so anyone can send it again without this page. */
function Asked({ rpcUrl, requests }: { rpcUrl: string; requests: RpcCall[] }) {
  const commands = requests.map((call) => curlFor(rpcUrl, call));
  return (
    <Disclosure summary={`What your browser asked, as ${commands.length === 1 ? "a command" : "commands"} you can run`}>
      <div className="mt-3 space-y-2">
        {commands.map((command) => (
          <div key={command} className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border-2 border-ink/15 bg-paper px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-ink-2">{command}</pre>
            <CopyButton value={command} label="Copy" />
          </div>
        ))}
      </div>
    </Disclosure>
  );
}

function Facts({ facts }: { facts: [string, string][] }) {
  if (facts.length === 0) return null;
  return (
    <dl className="mt-3 space-y-2 font-readout text-[12px] leading-snug">
      {facts.map(([label, value], i) => (
        <div key={`${label}-${i}`}>
          <dt className="break-all text-[11px] text-muted">{label}</dt>
          <dd className="break-words text-ink-2 [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CheckCard({
  claim,
  outcome,
  rpcUrl,
  requests,
  links,
}: {
  claim: string;
  outcome: Outcome;
  rpcUrl: string;
  requests: RpcCall[];
  links?: { label: string; href: string }[];
}) {
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <h3 className="text-[18px] font-bold leading-snug text-ink">{claim}</h3>
        <Stamp kind={outcome.status === "done" ? outcome.judged.verdict : outcome.status} />
      </div>
      {outcome.status === "checking" ? (
        <div className="mt-3 space-y-2" aria-hidden>
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : outcome.status === "error" ? (
        <p className="mt-2 text-[14.5px] leading-relaxed text-body">The node didn&apos;t answer: {outcome.message} That says nothing either way; run the checks again in a moment.</p>
      ) : (
        <>
          <p className="mt-2 text-[14.5px] leading-relaxed text-body">{outcome.judged.finding}</p>
          <Facts facts={outcome.judged.facts} />
        </>
      )}
      {links && links.length > 0 ? (
        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
          {links.map((link) => (
            <ExternalLink key={link.href} href={link.href}>
              {link.label}
            </ExternalLink>
          ))}
        </p>
      ) : null}
      <Asked rpcUrl={rpcUrl} requests={requests} />
    </Card>
  );
}

type Keys = { keys: AccessKeyInfo[] };
type ViewAnswer = { result?: number[]; error?: string };

/** NEP-330 metadata, or null for a contract that doesn't implement it. */
async function sourceMetadata(d: Deployment): Promise<SourceMetadata | null> {
  try {
    return viewResult<SourceMetadata>(await rpc<ViewAnswer>(d.rpcUrl, calls.view(d.vault, "contract_source_metadata")));
  } catch (error) {
    if (error instanceof RpcError && error.reason === "CONTRACT_ERROR") return null;
    throw error;
  }
}

/** The five things the chain itself can settle about one deployment. */
function DeploymentChecks({ d, run, onReport }: { d: Deployment; run: number; onReport: Report }) {
  const keeperKeys = useCheck(async () => {
    const [keys, account] = await Promise.all([rpc<Keys>(d.rpcUrl, calls.keys(d.keeper)), rpc<AccountView>(d.rpcUrl, calls.account(d.keeper))]);
    return judgeKeeperKeys(keys.keys, d.vault, account);
  }, run);
  const code = useCheck(async () => {
    const [account, metadata] = await Promise.all([rpc<AccountView>(d.rpcUrl, calls.account(d.vault)), sourceMetadata(d)]);
    return judgeVaultCode(account, metadata, d.vaultCodeHash);
  }, run);
  const vaultKeys = useCheck(async () => judgeVaultKeys((await rpc<Keys>(d.rpcUrl, calls.keys(d.vault))).keys), run);
  const vaultConfig = useCheck(async () => judgeVaultConfig(viewResult<VaultConfig>(await rpc<ViewAnswer>(d.rpcUrl, calls.view(d.vault, "get_config"))), d), run);
  const refusal = useCheck(async () => {
    if (d.refusal === null) throw new Error("No refused attack is recorded on this network yet.");
    const tx = await rpc<TxStatus>(d.rpcUrl, calls.tx(d.refusal.txHash, d.refusal.signer));
    return judgeRefusal(tx, { keeper: d.keeper, vault: d.vault, panic: d.refusal.panic, pointedAt: d.keeper });
  }, run);

  const states = { keeperKeys, code, vaultKeys, vaultConfig, refusal };
  useEffect(() => {
    for (const [key, outcome] of Object.entries(states)) onReport(`${d.network}:${key}`, reported(outcome));
  });

  return (
    <div className="grid gap-5 lg:grid-cols-6 [&>*]:min-w-0 [&>*]:lg:col-span-3 [&>*:nth-child(-n+3)]:lg:col-span-2">
      <CheckCard
        claim="The keeper can only call rescue"
        outcome={keeperKeys}
        rpcUrl={d.rpcUrl}
        requests={[calls.keys(d.keeper), calls.account(d.keeper)]}
        links={[{ label: d.keeper, href: nearblocksAccount(d.keeper, d.network) }]}
      />
      <CheckCard
        claim="The vault runs the code in this repo"
        outcome={code}
        rpcUrl={d.rpcUrl}
        requests={[calls.account(d.vault), calls.view(d.vault, "contract_source_metadata")]}
        links={[{ label: d.vault, href: nearblocksAccount(d.vault, d.network) }]}
      />
      <CheckCard
        claim="A hacked keeper was refused, on chain"
        outcome={refusal}
        rpcUrl={d.rpcUrl}
        requests={d.refusal ? [calls.tx(d.refusal.txHash, d.refusal.signer)] : []}
        links={d.refusal ? [{ label: "The transaction", href: nearblocksTx(d.refusal.txHash, d.network) }] : []}
      />
      <CheckCard claim="The vault takes quotes from one key" outcome={vaultConfig} rpcUrl={d.rpcUrl} requests={[calls.view(d.vault, "get_config")]} />
      <CheckCard claim="Nobody can swap the vault's code" outcome={vaultKeys} rpcUrl={d.rpcUrl} requests={[calls.keys(d.vault)]} />
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const mark = step.unavailable ? { sign: "?", label: "couldn't be checked", tone: "bg-shade text-ink" } : step.passed ? { sign: "✓", label: "passed", tone: "bg-safe text-ink" } : { sign: "✗", label: "failed", tone: "bg-danger text-paper" };
  return (
    <li className="flex gap-3 py-2.5">
      <span className={cx("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 border-ink text-[11px] font-bold", mark.tone)} role="img" aria-label={mark.label}>
        {mark.sign}
      </span>
      <span className="min-w-0">
        <span className="block text-[14.5px] font-semibold text-ink">{step.name}</span>
        <span className="block break-all font-readout text-[11.5px] text-muted">{step.detail}</span>
      </span>
    </li>
  );
}

type AiState =
  | { status: "loading" }
  | { status: "none"; reason: string }
  | { status: "error"; message: string }
  | { status: "ready"; proved: ProvedRecord; offline: OfflineCheck; ledger: Step | null; live: LiveCheck | null };

/** The verdict for the AI sentence: failed on any failed step, proven only once every step passed. */
function answerVerdict(state: AiState): Reported {
  if (state.status === "loading") return "checking";
  if (state.status === "none") return "nothing to check";
  if (state.status === "error") return "error";
  const offline = [...state.offline.steps, ...(state.ledger ? [state.ledger] : [])];
  if (offline.some((s) => !s.passed)) return "failed";
  if (state.ledger === null || state.live === null) return "checking";
  return { proven: "proven", rotated: "trusted", unavailable: "error", failed: "failed" }[state.live.outcome] as Reported;
}

/** The model's sentence on the ledger, checked from the bytes the keeper kept and NEAR AI's live hardware report. */
function AnswerCheck({ run, onReport }: { run: number; onReport: Report }) {
  const params = useSearchParams();
  const recordId = params.get("record");
  const user = params.get("user") ?? DEMO_USER;
  const base = keeperUrlFor(config, user);
  const [state, setState] = useState<AiState>({ status: "loading" });
  const [attestation, setAttestation] = useState<AttestationResponse | "unreachable" | null>(null);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    setAttestation(null);
    keeper.attestation(base).then(
      (a) => live && setAttestation(a),
      () => live && setAttestation("unreachable"),
    );
    (async () => {
      let proved: ProvedRecord;
      try {
        proved = await keeper.proof(base, recordId ?? "latest", recordId ? undefined : user);
      } catch (error) {
        if (!live) return;
        if (error instanceof KeeperError && error.status === 404) {
          setState({
            status: "none",
            reason: recordId
              ? "This record has only the facts the keeper wrote from it, with no model words, so there's no signature to check."
              : "No signed answer is kept yet. The keeper keeps one with each rescue a model explains.",
          });
        } else setState({ status: "error", message: message(error) });
        return;
      }
      const offline = checkProofOffline(proved, recordId ?? undefined);
      if (!live) return;
      setState({ status: "ready", proved, offline, ledger: null, live: null });
      const [ledger, liveCheck] = await Promise.all([
        keeper.audit(base, proved.record.user, 200).then(
          (records) => ledgerShows(records, proved),
          (): Step => ({ name: "The ledger shows the same words", passed: false, unavailable: true, detail: "the ledger didn't answer" }),
        ),
        offline.signer === null
          ? Promise.resolve<LiveCheck>({ outcome: "failed", nodes: 0, steps: [] })
          : checkKeyLive({ signer: offline.signer, model: proved.proof.model, nonce: randomNonce(), intel: () => loadIntel(), now: () => new Date() }),
      ]);
      if (live) setState({ status: "ready", proved, offline, ledger, live: liveCheck });
    })().catch((error: unknown) => {
      if (live) setState({ status: "error", message: message(error) });
    });
    return () => {
      live = false;
    };
  }, [base, recordId, user, run]);

  const verdict = answerVerdict(state);
  const gpu: Reported =
    attestation === null ? "checking" : attestation === "unreachable" || attestation.status === "not available" ? "error" : attestation.status === "verified" ? "trusted" : "failed";

  useEffect(() => {
    onReport("ai:answer", verdict);
    onReport("ai:gpu", gpu);
  }, [verdict, gpu, onReport]);

  const now = Date.now();
  const stamp = (r: Reported): StampKind => (r === "nothing to check" ? "error" : r);
  const checks = attestation !== null && attestation !== "unreachable" ? attestation.checks : [];

  return (
    <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr] [&>*]:min-w-0">
      <Card className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-[18px] font-bold leading-snug text-ink">The AI&apos;s sentence came from a verified enclave</h3>
          <Stamp kind={stamp(verdict)} />
        </div>
        {state.status === "loading" ? (
          <div className="mt-3 space-y-2" aria-hidden>
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : state.status === "none" ? (
          <p className="mt-2 text-[14.5px] leading-relaxed text-body">{state.reason}</p>
        ) : state.status === "error" ? (
          <p className="mt-2 text-[14.5px] leading-relaxed text-body">The keeper didn&apos;t answer: {state.message}</p>
        ) : (
          <AnswerBody state={state} now={now} />
        )}
      </Card>

      <Card className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-[18px] font-bold leading-snug text-ink">NVIDIA vouched for the GPUs</h3>
          <Stamp kind={stamp(gpu)} />
        </div>
        <p className="mt-2 text-[14.5px] leading-relaxed text-body">
          NVIDIA&apos;s attestation service doesn&apos;t take requests from browsers, so this card is the one that comes from the keeper: it checks NEAR AI&apos;s whole report through
          NVIDIA and Intel
          {attestation !== null && attestation !== "unreachable" && attestation.checkedAt ? `, last ${timeAgo(attestation.checkedAt, now)}` : ""}. Run the same check yourself
          with <code className="font-readout text-[12.5px]">pnpm --filter keeper attest</code>.
        </p>
        {checks.length > 0 ? (
          <ul className="mt-2 divide-y-2 divide-ink/10">
            {checks.map((check) => (
              <StepRow key={check.name} step={{ name: `${check.name.charAt(0).toUpperCase()}${check.name.slice(1)}`, passed: check.passed, detail: check.detail ?? "" }} />
            ))}
          </ul>
        ) : null}
      </Card>
    </div>
  );
}

function AnswerBody({ state, now }: { state: Extract<AiState, { status: "ready" }>; now: number }) {
  const { proved, offline, ledger, live } = state;
  const explanation = proved.record.explanation ?? "";
  const words = offline.words && explanation.endsWith(offline.words) ? offline.words : null;
  const facts = words ? explanation.slice(0, explanation.length - words.length) : explanation;
  return (
    <>
      <blockquote className="mt-3 border-l-[3px] border-rescue pl-3 text-[15px] leading-relaxed text-ink">
        {facts}
        {words ? <mark className="rounded-sm bg-sun/60 px-0.5 text-ink [box-decoration-break:clone]">{words}</mark> : null}
      </blockquote>
      <p className="mt-2 text-[12.5px] text-muted">
        Plain: written by the keeper from the record. <mark className="rounded-sm bg-sun/60 px-0.5 text-ink">Highlighted</mark>: the model&apos;s words, as it signed them.{" "}
        <Link href={pageHref("/history", proved.record.user)} className="underline decoration-line-strong underline-offset-2 hover:text-ink">
          {proved.record.kind.replace("RESCUE_", "").toLowerCase()} for {proved.record.user}, {timeAgo(proved.record.at, now)}
        </Link>
      </p>

      <Disclosure summary="Everything the model was told">
        <pre className="mt-2 overflow-x-auto rounded-md border-2 border-ink/15 bg-paper px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-ink-2">{JSON.stringify(offline.facts, null, 2)}</pre>
        <p className="mt-1.5 text-[12.5px] text-muted">Numbers and plain facts only: no account, address or deposit detail leaves the keeper.</p>
      </Disclosure>

      <p className="mt-5 font-readout text-[11px] uppercase tracking-[0.08em] text-muted">From the kept bytes and the public ledger, in this browser</p>
      <ul className="divide-y-2 divide-ink/10">
        {offline.steps.map((step) => (
          <StepRow key={step.name} step={step} />
        ))}
        {ledger ? <StepRow step={ledger} /> : null}
      </ul>

      <p className="mt-4 font-readout text-[11px] uppercase tracking-[0.08em] text-muted">Live from NEAR AI Cloud and Intel, with a nonce made here</p>
      {live === null ? (
        <p className="flex items-center gap-2 py-2.5 text-[13.5px] text-muted">
          <span className="size-2 animate-pulse rounded-full bg-sea" aria-hidden />
          Fetching the hardware report and Intel&apos;s certificates…
        </p>
      ) : (
        <>
          <ul className="divide-y-2 divide-ink/10">
            {live.steps.map((step) => (
              <StepRow key={step.name} step={step} />
            ))}
          </ul>
          {live.outcome === "rotated" ? (
            <p className="mt-1 text-[13px] leading-relaxed text-body">
              NEAR AI rotates its signing keys. The keeper checked this one against a fully verified report when it kept the answer, {timeAgo(proved.proof.verifiedAt, now)}.
            </p>
          ) : live.outcome === "unavailable" ? (
            <p className="mt-1 text-[13px] leading-relaxed text-body">A service didn&apos;t answer, which says nothing either way. Run the checks again in a moment.</p>
          ) : null}
        </>
      )}
    </>
  );
}

const TRUSTED_ANYWAY = [
  "The keeper's code runs on Cloudflare, not in an enclave. You trust it to watch your account and size rescues on time. You don't trust it with money: its key can only call rescue, and the vault refuses any rescue your policy doesn't allow.",
  "NEAR AI's attestation proves the hardware and the signing key, not which model weights run: the report doesn't pin the enclave's software to a known build, and the model name is signed by the enclave's key, not by the hardware.",
  "The hosted demo watches a pretend position and settles pretend rescues. Its ETH prices and 1Click quotes are real ones.",
  "Hyperliquid reports health and 1Click delivers the money. Lifeline checks 1Click's signed quote on chain, but can't make either service answer.",
];

/** Every claim that can be settled without asking Lifeline, settled in the browser. */
export function VerifyView() {
  const [run, setRun] = useState(0);
  const [states, setStates] = useState<Record<string, Reported>>({});
  const onReport = useCallback<Report>((key, state) => {
    setStates((current) => (current[key] === state ? current : { ...current, [key]: state }));
  }, []);
  const values = Object.values(states);
  const expected = DEPLOYMENTS.length * 5 + 2;
  const counted = expected - values.filter((v) => v === "nothing to check").length;
  const count = (v: Reported) => values.filter((s) => s === v).length;
  const pending = expected - values.length + count("checking");
  const checking = pending > 0;

  return (
    <>
      <PageHeader
        eyebrow="Don't take our word for it"
        title="Check it yourself"
        aside={
          <Button variant="primary" size="lg" busy={checking && run > 0} onClick={() => setRun((n) => n + 1)}>
            Run every check again
          </Button>
        }
      >
        Every check but one runs in your browser: it asks a public NEAR node, NEAR AI Cloud and Intel&apos;s certificates directly and judges the answer on this page. Each chain
        check shows its request, so you can run it again without us. <strong className="text-ink">Proven</strong> means the chain or the hardware says so.{" "}
        <strong className="text-ink">Trusted</strong> means it&apos;s true only because we say so today, and says what would change that.
      </PageHeader>

      <p className="mb-10 flex flex-wrap items-center gap-x-5 gap-y-2 font-readout text-[13px] text-ink-2" aria-live="polite">
        <span>
          <span className="text-[22px] font-semibold text-safe-ink">{count("proven")}</span> proven
        </span>
        <span>
          <span className="text-[22px] font-semibold text-warn-ink">{count("trusted")}</span> trusted
        </span>
        <span>
          <span className="text-[22px] font-semibold text-danger-ink">{count("failed")}</span> failed
        </span>
        {count("error") > 0 ? (
          <span>
            <span className="text-[22px] font-semibold text-muted">{count("error")}</span> no answer
          </span>
        ) : null}
        <span className="text-muted">{checking ? `checking ${pending} more…` : `all ${counted} checked ${run > 0 ? "again " : ""}just now`}</span>
      </p>

      {DEPLOYMENTS.map((d) => (
        <section key={d.network} className="mb-14" aria-labelledby={`chain-${d.network}`}>
          <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id={`chain-${d.network}`} className="text-[clamp(28px,3.4vw,44px)] font-extrabold uppercase leading-none text-ink [font-variation-settings:'wdth'_70]">
              The vault and keeper, on NEAR {d.network}
            </h2>
            <span className="text-[13px] text-muted">The mainnet deployment joins this page at launch.</span>
          </div>
          <DeploymentChecks d={d} run={run} onReport={onReport} />
        </section>
      ))}

      <section id="ai" className="mb-14 scroll-mt-24" aria-labelledby="ai-title">
        <h2 id="ai-title" className="mb-5 text-[clamp(28px,3.4vw,44px)] font-extrabold uppercase leading-none text-ink [font-variation-settings:'wdth'_70]">
          The AI&apos;s words, on the ledger
        </h2>
        <AnswerCheck run={run} onReport={onReport} />
      </section>

      <section aria-labelledby="trusted-title">
        <Notice tone="warn" title={<span id="trusted-title">What you still take on trust</span>}>
          <ul className="mt-1 list-disc space-y-1.5 pl-5">
            {TRUSTED_ANYWAY.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Notice>
      </section>
    </>
  );
}
