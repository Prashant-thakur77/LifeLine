"use client";

import { useEffect, useMemo, useState } from "react";
import { ASSETS } from "@lifeline/shared";
import { usePoll } from "../hooks/usePoll";
import { DEMO_USER } from "../lib/config";
import { config } from "../lib/env";
import { formatUnits, formatUsd, parseUnits } from "../lib/format";
import { intentsExplorer, pageHref } from "../lib/links";
import {
  buildFundingQuote,
  chainName,
  fundingChains,
  fundingQuoteProblem,
  getQuote,
  getStatus,
  getTokens,
  statusInfo,
  submitDepositTx,
  type OneClickToken,
  type QuoteResponse,
  type StatusResponse,
  type Tone as StatusTone,
} from "../lib/oneclick";
import { depositBounced, describeTxError } from "../lib/tx";
import { depositTx, registerTokenTx, tokenViews, vaultViews } from "../lib/vault";
import { TxStatus, useTx } from "./Tx";
import { Button, ButtonLink, Card, CardHeader, CopyButton, ExternalLink, Field, inputClass, Notice, PageHeader, Skeleton, cx, type Tone } from "./ui";
import { useWallet } from "./WalletProvider";

const USDC_DECIMALS = ASSETS.NEAR_USDC.decimals;

export function FundView() {
  const { status, accountId, connect } = useWallet();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <PageHeader eyebrow="Fund your reserve" title="Pay from any chain">
        Two moves. First, 1Click swaps whatever you pay with into USDC on NEAR, delivered to your own NEAR account. Then one transaction moves that USDC into
        your reserve in the vault, where only rescues to your Hyperliquid address and your own withdrawals can touch it.
      </PageHeader>
      {accountId ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <PayFromAnyChain key={accountId} account={accountId} />
          </div>
          <div className="lg:col-span-5">
            <MoveIntoReserve key={accountId} account={accountId} />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <Card className="self-start p-6 lg:order-2 lg:col-span-5">
          <h2 className="text-[20px] font-bold leading-snug text-ink">Connect the account that will hold the reserve</h2>
          <p className="mt-2 max-w-xl text-[14.5px] leading-relaxed text-body">
            1Click delivers USDC to your NEAR account, and the vault credits the reserve to whoever deposits it, so funding needs your wallet. To see Lifeline
            work without one, <a className="text-ink underline decoration-line-strong underline-offset-2" href={pageHref("/position", "demo.near")}>open the live demo</a>.
          </p>
          <Button
            variant="primary"
            className="mt-5"
            disabled={status !== "ready"}
            onClick={async () => {
              setError(null);
              try {
                await connect();
              } catch (e) {
                setError(describeTxError(e));
              }
            }}
          >
            Connect wallet
          </Button>
          {error ? <p className="mt-2 text-[13px] text-danger-ink">{error}</p> : null}
        </Card>
        <div className="lg:order-1 lg:col-span-7">
          <PayFromAnyChain account={null} />
        </div>
        </div>
      )}
    </>
  );
}

// ---- Step 1: 1Click ----

type ActiveDeposit = { quote: QuoteResponse; symbol: string; chain: string; createdAt: string };

const storageKey = (account: string) => `lifeline:funding:${account}`;

/** A per-browser convenience: a reload keeps following the deposit. Never required. */
function loadDeposit(account: string): ActiveDeposit | null {
  try {
    const raw = localStorage.getItem(storageKey(account));
    return raw ? (JSON.parse(raw) as ActiveDeposit) : null;
  } catch {
    return null;
  }
}

function saveDeposit(account: string, deposit: ActiveDeposit | null) {
  try {
    if (deposit) localStorage.setItem(storageKey(account), JSON.stringify(deposit));
    else localStorage.removeItem(storageKey(account));
  } catch {
    // Storage blocked: the deposit is still on screen, it just won't survive a reload.
  }
}

/** With no account it still quotes, dry only, so anyone can see the routes and prices. */
function PayFromAnyChain({ account }: { account: string | null }) {
  const tokens = usePoll("oneclick-tokens", getTokens, null);
  const chains = useMemo(() => fundingChains(tokens.data ?? []), [tokens.data]);
  const [chain, setChain] = useState("eth");
  const [assetId, setAssetId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [refund, setRefund] = useState("");
  const [preview, setPreview] = useState<QuoteResponse | null>(null);
  const [busy, setBusy] = useState<"preview" | "deposit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveDeposit | null>(null);

  useEffect(() => setActive(account ? loadDeposit(account) : null), [account]);

  // Ethereum first by default; if 1Click ever drops it, fall back to the first chain listed.
  const chainId = chains.some((c) => c.chain === chain) ? chain : (chains[0]?.chain ?? chain);
  const chainTokens = chains.find((c) => c.chain === chainId)?.tokens ?? [];
  const token: OneClickToken | null = chainTokens.find((t) => t.assetId === assetId) ?? chainTokens[0] ?? null;
  const parsed = token ? parseUnits(amount, token.decimals) : null;
  const amountError = amount.trim() === "" ? null : parsed && !parsed.ok ? parsed.error : parsed?.ok && BigInt(parsed.base) === 0n ? "Enter an amount above 0." : null;
  const usdValue = parsed?.ok && token ? Number(amount) * token.price : null;

  const reset = () => {
    setPreview(null);
    setError(null);
  };

  const quote = async (dry: boolean) => {
    if (!token || !parsed?.ok || BigInt(parsed.base) === 0n) {
      setError("Pick a token and enter an amount first.");
      return;
    }
    if (!account && !dry) return;
    setBusy(dry ? "preview" : "deposit");
    setError(null);
    try {
      const response = await getQuote(
        buildFundingQuote({
          originAsset: token.assetId,
          originChain: token.blockchain,
          amountBase: parsed.base,
          // A dry quote creates nothing, and any existing account prices the same route.
          nearAccount: account ?? DEMO_USER,
          refundAddress: refund,
          dry,
          nowMs: Date.now(),
        }),
      );
      if (dry) setPreview(response);
      else if (!response.quote.depositAddress) setError("1Click didn't return a deposit address. Try again.");
      else if (account && fundingQuoteProblem(response, account)) setError(fundingQuoteProblem(response, account));
      else if (account) {
        const deposit: ActiveDeposit = { quote: response, symbol: token.symbol, chain: token.blockchain, createdAt: new Date().toISOString() };
        saveDeposit(account, deposit);
        setActive(deposit);
        setPreview(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (active && account) {
    return (
      <DepositTracker
        deposit={active}
        account={account}
        onReset={() => {
          saveDeposit(account, null);
          setActive(null);
          setAmount("");
        }}
      />
    );
  }

  return (
    <Card>
      <CardHeader eyebrow="Step 1 · through 1Click" title="Swap into USDC on NEAR" />
      <div className="flex flex-col gap-4 p-5">
        {tokens.loading ? (
          <Skeleton className="h-24" />
        ) : tokens.error && !tokens.data ? (
          <Notice tone="danger" title="Couldn't load 1Click's token list" action={<Button size="sm" onClick={tokens.refresh}>Try again</Button>}>
            {tokens.error.message}
          </Notice>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Pay from" htmlFor="chain">
                <select
                  id="chain"
                  className={inputClass}
                  value={chainId}
                  onChange={(e) => {
                    setChain(e.target.value);
                    setAssetId(null);
                    reset();
                  }}
                >
                  {chains.map((c) => (
                    <option key={c.chain} value={c.chain}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Token" htmlFor="token">
                <select
                  id="token"
                  className={inputClass}
                  value={token?.assetId ?? ""}
                  onChange={(e) => {
                    setAssetId(e.target.value);
                    reset();
                  }}
                >
                  {chainTokens.map((t) => (
                    <option key={t.assetId} value={t.assetId}>
                      {t.symbol}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field
              label={`Amount${token ? ` of ${token.symbol}` : ""}`}
              htmlFor="amount"
              error={amountError}
              hint={usdValue !== null && Number.isFinite(usdValue) ? `About ${formatUsd(usdValue)} at 1Click's price.` : "What you'll send from your wallet on that chain."}
            >
              <input
                id="amount"
                inputMode="decimal"
                className={cx(inputClass, "num")}
                placeholder="0.00"
                value={amount}
                aria-invalid={amountError ? true : undefined}
                onChange={(e) => {
                  setAmount(e.target.value);
                  reset();
                }}
              />
            </Field>
            <Field
              label={`Refund address on ${chainName(chainId)} (optional)`}
              htmlFor="refund"
              hint={`If the swap can't complete, 1Click refunds here. Leave it empty to refund into ${account ?? "your account"}'s NEAR Intents balance instead.`}
            >
              <input
                id="refund"
                className={cx(inputClass, "num")}
                placeholder="Your address on that chain"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={refund}
                onChange={(e) => {
                  setRefund(e.target.value);
                  reset();
                }}
              />
            </Field>
            <p className="text-[13px] text-muted">
              {account ? (
                <>
                  USDC goes to <span className="text-ink-2">{account}</span>, the account you&apos;re connected with.
                </>
              ) : (
                "Without a wallet this only prices the swap. Connect one to get a deposit address that pays your own account."
              )}
            </p>

            {preview ? (
              <div className="rounded-lg border-2 border-ink bg-card p-4">
                <p className="text-[13px] text-muted">1Click&apos;s quote</p>
                <p className="mt-1 text-[15px] text-ink">
                  Send <span className="num text-ink">{preview.quote.amountInFormatted} {token?.symbol}</span>, receive about{" "}
                  <span className="num text-safe-ink">{formatUnits(preview.quote.amountOut, USDC_DECIMALS)} USDC</span>
                </p>
                <p className="mt-1 text-[13px] text-muted">
                  At least <span className="num">{formatUnits(preview.quote.minAmountOut, USDC_DECIMALS)} USDC</span> after 1% slippage, about{" "}
                  {preview.quote.timeEstimate} s after your deposit confirms.
                </p>
                {account ? (
                  <Button variant="primary" className="mt-4 w-full sm:w-auto" busy={busy === "deposit"} onClick={() => quote(false)}>
                    Get my deposit address
                  </Button>
                ) : (
                  <p className="mt-3 text-[13px] text-body">Connect a wallet to turn this into a real deposit address.</p>
                )}
              </div>
            ) : (
              <Button variant="secondary" className="self-start" busy={busy === "preview"} disabled={!token || !parsed?.ok} onClick={() => quote(true)}>
                Get a quote
              </Button>
            )}
            {error ? <Notice tone="danger" title="1Click couldn't quote that">{error}</Notice> : null}
          </>
        )}
      </div>
    </Card>
  );
}

const STEPS = ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"] as const;
const STEP_LABEL = ["Deposit", "Seen", "Swapping", "Delivered"];

const NOTICE_TONE: Record<StatusTone, Tone> = { waiting: "info", progress: "rescue", success: "safe", warning: "warn", error: "danger" };

function DepositTracker({ deposit, account, onReset }: { deposit: ActiveDeposit; account: string; onReset: () => void }) {
  const { quote, symbol, chain } = deposit;
  const address = quote.quote.depositAddress!;
  const memo = quote.quote.depositMemo;
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "busy" | "sent" | string>("idle");
  const [confirmReset, setConfirmReset] = useState(false);
  const current = status?.status ?? "PENDING_DEPOSIT";
  const info = statusInfo(current, chainName(chain));

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getStatus(address, memo);
        if (cancelled) return;
        setStatus(next);
        setStatusError(null);
        if (statusInfo(next.status).final) return;
      } catch (e) {
        if (!cancelled) setStatusError(e instanceof Error ? e.message : String(e));
      }
      if (!cancelled) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [address, memo]);

  const stepIndex = STEPS.indexOf(current as (typeof STEPS)[number]);
  const deadline = quote.quote.deadline ?? quote.quoteRequest.deadline;

  return (
    <Card>
      <CardHeader eyebrow="Step 1 · through 1Click" title={`Send ${symbol} on ${chainName(chain)}`} />
      <div className="flex flex-col gap-5 p-5">
        <div className="rounded-lg border-2 border-ink bg-[#ffe1d4] p-4">
          <p className="text-[13px] text-body">Send exactly</p>
          <p className="num mt-0.5 text-[22px] text-ink">
            {quote.quote.amountInFormatted} {symbol}
          </p>
          <p className="mt-3 text-[13px] text-body">on {chainName(chain)}, to this deposit address</p>
          <p className="num mt-1 break-all text-[15px] text-ink">{address}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <CopyButton value={address} label="Copy address" />
            <CopyButton value={quote.quote.amountInFormatted} label="Copy amount" />
          </div>
          {memo ? (
            <div className="mt-4 rounded-lg border border-warn/50 bg-warn/10 p-3">
              <p className="text-[13px] font-semibold text-warn-ink">Include this memo, or the deposit is lost</p>
              <p className="num mt-1 break-all text-ink">{memo}</p>
              <div className="mt-2">
                <CopyButton value={memo} label="Copy memo" />
              </div>
            </div>
          ) : null}
          <p className="mt-4 text-[13px] leading-relaxed text-muted">
            Only {symbol} on {chainName(chain)}. Anything else sent here can be lost. You&apos;ll receive at least{" "}
            <span className="num text-ink-2">{formatUnits(quote.quote.minAmountOut, USDC_DECIMALS)} USDC</span> in {quote.quoteRequest.recipient}. Deposit before{" "}
            {new Date(deadline).toLocaleString()}, or 1Click refunds what it received.
          </p>
        </div>

        <ol className="grid grid-cols-4 gap-1.5" aria-label="Progress">
          {STEP_LABEL.map((label, i) => {
            const reached = stepIndex >= i || current === "SUCCESS";
            const now = stepIndex === i && current !== "SUCCESS";
            return (
              <li key={label} className="flex flex-col gap-1.5">
                <span className={cx("h-1.5 rounded-full", reached ? (current === "SUCCESS" ? "bg-safe" : "bg-rescue") : "bg-shade", now && "animate-pulse-soft")} />
                <span className={cx("text-[12px]", reached ? "text-ink" : "text-muted")}>{label}</span>
              </li>
            );
          })}
        </ol>

        <Notice tone={NOTICE_TONE[info.tone]} title={info.title}>
          <p>{info.detail}</p>
          {status?.swapDetails?.refundReason ? <p className="mt-1">Reason given: {status.swapDetails.refundReason}.</p> : null}
          {current === "SUCCESS" && status?.swapDetails?.amountOutFormatted ? (
            <p className="mt-1">
              Delivered: <span className="num">{Number(status.swapDetails.amountOutFormatted).toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC</span>.
            </p>
          ) : null}
        </Notice>
        {statusError ? <p className="text-[13px] text-warn-ink">Couldn&apos;t check the status just now ({statusError}). Retrying every 5 s.</p> : null}

        {current === "PENDING_DEPOSIT" || current === "INCOMPLETE_DEPOSIT" ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!txHash.trim()) return;
              setSubmitState("busy");
              try {
                await submitDepositTx(address, txHash.trim(), memo);
                setSubmitState("sent");
              } catch (e) {
                setSubmitState(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            <Field label="Sent it? Paste the transaction hash to speed things up (optional)" htmlFor="tx-hash">
              <div className="flex gap-2">
                <input id="tx-hash" className={cx(inputClass, "num")} placeholder="0x… or the hash from your wallet" value={txHash} onChange={(e) => setTxHash(e.target.value)} autoCapitalize="none" spellCheck={false} />
                <Button type="submit" className="h-11" busy={submitState === "busy"}>
                  Send
                </Button>
              </div>
            </Field>
            {submitState === "sent" ? <p className="text-[13px] text-safe-ink">Passed to 1Click.</p> : null}
            {submitState !== "idle" && submitState !== "busy" && submitState !== "sent" ? <p className="text-[13px] text-danger-ink">{submitState}</p> : null}
          </form>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-ink/10 pt-4 text-[13px] text-muted">
          <span>
            Quote <span className="num text-body">{quote.correlationId}</span>
          </span>
          <ExternalLink href={intentsExplorer(address)} className="text-ink-2">
            Follow it on the NEAR Intents explorer
          </ExternalLink>
        </div>

        {info.final ? (
          <Button variant="secondary" className="self-start" onClick={onReset}>
            Fund again
          </Button>
        ) : confirmReset ? (
          <Notice tone="warn" title="Only start over if you haven't sent anything" action={
            <div className="flex gap-2">
              <Button size="sm" variant="danger" onClick={onReset}>Start over</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>Keep following</Button>
            </div>
          }>
            A deposit already sent to this address still completes, but this page would stop following it. Keep the address: the explorer link above
            finds it later.
          </Notice>
        ) : (
          <button type="button" onClick={() => setConfirmReset(true)} className="self-start text-[13px] text-muted underline decoration-line-strong underline-offset-[3px] hover:text-ink">
            Start a different deposit
          </button>
        )}
      </div>
    </Card>
  );
}

// ---- Step 2: into the vault ----

function MoveIntoReserve({ account }: { account: string }) {
  const vault = config.vaultId;
  const usdc = config.usdcContractId;
  const balance = usePoll(`fund-bal:${usdc}:${account}`, () => tokenViews.balance(config.rpcUrl, usdc, account), 10_000);
  const registration = usePoll(`fund-reg:${usdc}:${account}`, () => tokenViews.storageBalance(config.rpcUrl, usdc, account), null);
  const policy = usePoll(vault ? `fund-policy:${vault}:${account}` : null, () => vaultViews.policy(config.rpcUrl, vault!, account), null);
  const reserve = usePoll(vault ? `fund-reserve:${vault}:${account}` : null, () => vaultViews.reserve(config.rpcUrl, vault!, account), 15_000);
  const [amount, setAmount] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const deposit = useTx();
  const register = useTx();
  const [registerError, setRegisterError] = useState<string | null>(null);

  const walletUsdc = balance.data ?? "0";
  const reserveUsdc = reserve.data?.[usdc] ?? "0";
  const notRegistered = registration.data === null;

  return (
    <Card>
      <CardHeader eyebrow="Step 2 · into the vault" title="Move USDC into your reserve" />
      <div className="flex flex-col gap-4 p-5">
        <dl className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border-2 border-ink bg-card p-3">
            <dt className="text-[12px] text-muted">In your NEAR account</dt>
            <dd className="num mt-1 text-[20px] text-ink">{balance.loading ? "…" : balance.error ? "?" : formatUnits(walletUsdc, USDC_DECIMALS)}</dd>
            <dd className="text-[12px] text-muted">USDC</dd>
          </div>
          <div className="rounded-lg border-2 border-ink bg-card p-3">
            <dt className="text-[12px] text-muted">In your reserve</dt>
            <dd className="num mt-1 text-[20px] text-safe-ink">{!vault ? "—" : reserve.loading ? "…" : reserve.error ? "?" : formatUnits(reserveUsdc, USDC_DECIMALS)}</dd>
            <dd className="text-[12px] text-muted">USDC</dd>
          </div>
        </dl>
        {balance.error ? <p className="text-[13px] text-warn-ink">Couldn&apos;t read your USDC balance: {balance.error.message}</p> : null}

        {notRegistered ? (
          <Notice
            tone="warn"
            title="Your account isn't registered with USDC yet"
            action={
              <Button
                size="sm"
                variant="primary"
                busy={register.busy}
                onClick={async () => {
                  setRegisterError(null);
                  const bounds = await tokenViews.storageBounds(config.rpcUrl, usdc).catch(() => null);
                  if (!bounds) {
                    setRegisterError("Couldn't read the USDC contract's storage price. Try again.");
                    return;
                  }
                  if (await register.run(registerTokenTx(usdc, account, bounds.min))) registration.refresh();
                }}
              >
                Register (0.00125 NEAR)
              </Button>
            }
          >
            A NEAR account needs a one-off storage deposit with the USDC contract before it can hold USDC. Do this before funding, so the swap has
            somewhere to land.
            <div className="mt-2">
              <TxStatus state={register.state} doneTitle="Registered with USDC" />
              {registerError ? <p className="text-[13px] text-danger-ink">{registerError}</p> : null}
            </div>
          </Notice>
        ) : null}

        {!vault ? (
          <Notice tone="warn" title="The vault isn't deployed yet">
            USDC you fund now waits safely in your NEAR account. Once the vault is live, this is where you move it into your reserve.
          </Notice>
        ) : policy.loading ? (
          <Skeleton className="h-16" />
        ) : policy.error ? (
          <Notice tone="danger" title="Couldn't read the vault">{policy.error.message}</Notice>
        ) : policy.data === null ? (
          <Notice tone="warn" title="Set a policy first" action={<ButtonLink href="/start" variant="primary" size="sm">Set up protection</ButtonLink>}>
            The vault refuses deposits from accounts without a policy, and USDC sends a refused deposit straight back. Set your policy, then come back.
          </Notice>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (event) => {
              event.preventDefault();
              const parsed = parseUnits(amount, USDC_DECIMALS);
              if (!parsed.ok) return setAmountError(parsed.error);
              if (BigInt(parsed.base) === 0n) return setAmountError("Enter an amount above 0.");
              if (BigInt(parsed.base) > BigInt(walletUsdc)) return setAmountError("That's more USDC than your account holds.");
              const ok = await deposit.run(
                depositTx(usdc, vault, parsed.base),
                (outcome) => (depositBounced(outcome) ? "The vault didn't accept the deposit, so USDC returned it to your account." : null),
                "It's in your reserve. The keeper can now rescue with it, within your caps.",
              );
              if (ok) {
                setAmount("");
                balance.refresh();
                reserve.refresh();
              }
            }}
          >
            <Field label="Amount (USDC)" htmlFor="deposit-amount" error={amountError} hint="ft_transfer_call to the vault, with 1 yoctoNEAR so your wallet asks you to confirm.">
              <div className="flex gap-2">
                <input
                  id="deposit-amount"
                  inputMode="decimal"
                  className={cx(inputClass, "num")}
                  placeholder="0.00"
                  value={amount}
                  aria-invalid={amountError ? true : undefined}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setAmountError(null);
                  }}
                />
                <Button variant="ghost" className="h-11" onClick={() => setAmount(formatUnits(walletUsdc, USDC_DECIMALS, USDC_DECIMALS).replace(/,/g, ""))}>
                  Max
                </Button>
              </div>
            </Field>
            <Button type="submit" variant="primary" className="self-start" busy={deposit.busy} disabled={BigInt(walletUsdc) === 0n}>
              Move into reserve
            </Button>
            {BigInt(walletUsdc) === 0n && !balance.loading ? <p className="text-[13px] text-muted">No USDC in your account yet. Fund it with step 1.</p> : null}
            <TxStatus state={deposit.state} doneTitle="Deposited" />
          </form>
        )}
      </div>
    </Card>
  );
}
