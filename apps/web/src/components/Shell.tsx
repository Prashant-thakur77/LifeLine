"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { DEMO_USER, networkLabel } from "../lib/config";
import { config } from "../lib/env";
import { shortMiddle } from "../lib/format";
import { pageHref } from "../lib/links";
import { describeTxError } from "../lib/tx";
import { Button, cx, PaperRule } from "./ui";
import { useWallet } from "./WalletProvider";

/** A lifebuoy: the mark. A white ring with four signal-orange quarters, outlined in ink like a printed object. */
export function Mark({ className, quarters = "#ff5a1f" }: { className?: string; quarters?: string }) {
  const c = 2 * Math.PI * 8.5;
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="#fffcf5" strokeWidth="5" />
      <circle
        cx="12"
        cy="12"
        r="8.5"
        fill="none"
        stroke={quarters}
        strokeWidth="5"
        strokeDasharray={`${c / 8} ${c / 8}`}
        transform="rotate(-22.5 12 12)"
      />
      <circle cx="12" cy="12" r="11.1" fill="none" stroke="#0b1533" strokeWidth="1.1" />
      <circle cx="12" cy="12" r="5.9" fill="none" stroke="#0b1533" strokeWidth="1.1" />
    </svg>
  );
}

const NAV = [
  { href: "/position", label: "Position", keepsUser: true },
  { href: "/check", label: "Check", keepsUser: false },
  { href: "/ledger", label: "Ledger", keepsUser: false },
  { href: "/verify", label: "Verify", keepsUser: false },
  { href: "/attack", label: "Rob it", keepsUser: false },
  { href: "/fund", label: "Fund", keepsUser: false },
  { href: "/start", label: "Set up", keepsUser: false },
  { href: "/telegram", label: "Alerts", keepsUser: false },
] as const;

function NavLinks({ className }: { className?: string }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const user = params.get("user");
  const nav = useRef<HTMLElement>(null);
  // On a narrow screen the row scrolls: bring the current page into view.
  useEffect(() => {
    const el = nav.current;
    const current = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !current || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = current.offsetLeft - (el.clientWidth - current.offsetWidth) / 2;
  }, [pathname]);
  return (
    <nav ref={nav} className={className} aria-label="Main">
      {NAV.map((item) => {
        const active = pathname === item.href || pathname === `${item.href}/`;
        return (
          <Link
            key={item.href}
            href={item.keepsUser ? pageHref(item.href, user) : item.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "shrink-0 rounded-md px-3 py-1.5 text-[15px] font-semibold transition-colors",
              active ? "bg-ink text-paper" : "text-ink-2 hover:bg-sun hover:text-ink",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function WalletButton() {
  const { status, accountId, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (status === "loading") {
    return (
      <Button size="sm" variant="primary" aria-disabled title="The wallet connector is loading" className="cursor-progress">
        Connect wallet
      </Button>
    );
  }
  if (status === "unavailable") {
    return (
      <Button size="sm" variant="secondary" disabled title="The wallet connector couldn't load. Reload to try again.">
        Wallet unavailable
      </Button>
    );
  }
  if (!accountId) {
    return (
      <div className="relative">
        <Button
          size="sm"
          variant="primary"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await connect();
            } catch (e) {
              setError(describeTxError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Connect wallet
        </Button>
        {error ? (
          <p role="alert" className="absolute right-0 top-10 z-30 w-64 rounded-lg border border-danger/40 bg-card p-3 text-[13px] text-ink-2 shadow-xl">
            {error}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-8 max-w-[170px] items-center gap-2 rounded-lg border-2 border-ink bg-card px-3 text-[13px] font-medium text-ink hover:border-line-strong"
      >
        <span className="size-2 shrink-0 rounded-full bg-safe" aria-hidden />
        <span className="truncate">{shortMiddle(accountId, 10, 6)}</span>
      </button>
      {open ? (
        <div className="absolute right-0 top-10 z-30 w-56 overflow-hidden rounded-lg border-2 border-ink bg-card shadow-[4px_4px_0_var(--color-ink)]">
          <p className="truncate border-b border-line px-4 py-3 text-[12px] text-muted">
            Signed in as <span className="text-ink">{accountId}</span>
          </p>
          <Link href={pageHref("/position", accountId)} onClick={() => setOpen(false)} className="block px-4 py-2.5 text-[14px] text-ink hover:bg-shade">
            My position
          </Link>
          <Link href={pageHref("/history", accountId)} onClick={() => setOpen(false)} className="block px-4 py-2.5 text-[14px] text-ink hover:bg-shade">
            My history
          </Link>
          <button
            type="button"
            onClick={async () => {
              setOpen(false);
              await disconnect();
            }}
            className="block w-full px-4 py-2.5 text-left text-[14px] text-danger-ink hover:bg-shade"
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b-2 border-ink bg-paper">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-5 px-4 sm:px-6">
        <Link href="/" className="group flex shrink-0 items-center gap-2.5" aria-label="Lifeline home">
          <Mark className="size-8 transition-transform duration-500 group-hover:rotate-[90deg]" />
          <span className="text-[24px] font-black uppercase leading-none tracking-[-0.01em] text-ink [font-variation-settings:'wdth'_72]">Lifeline</span>
        </Link>
        <Suspense fallback={<div className="hidden flex-1 md:block" />}>
          <NavLinks className="hidden flex-1 items-center gap-1 md:flex" />
        </Suspense>
        <div className="ml-auto md:ml-0">
          <WalletButton />
        </div>
      </div>
      <Suspense fallback={<div className="h-11 md:hidden" />}>
        <NavLinks className="scrollbar-none flex h-11 items-center gap-1 overflow-x-auto border-t-2 border-ink/10 px-3 [mask-image:linear-gradient(to_right,black_85%,transparent)] md:hidden" />
      </Suspense>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mt-28">
      <PaperRule className="h-8" />
      <div className="bg-sea-deep text-paper">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-4 pb-10 pt-12 sm:px-6 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <div className="flex items-center gap-3">
              <Mark className="size-10" />
              <span className="text-[clamp(44px,7vw,96px)] font-black uppercase leading-none tracking-[-0.01em] [font-variation-settings:'wdth'_72]">Lifeline</span>
            </div>
            <p className="mt-4 max-w-md text-[15px] leading-relaxed text-paper/85">Auto top-up for onchain perps, funded from any chain. The vault only ever pays your own Hyperliquid address.</p>
          </div>
          <div className="grid grid-cols-2 gap-8 lg:col-span-5">
            <nav aria-label="Footer" className="flex flex-col gap-2 text-[15px]">
              {NAV.map((item) => (
                <Link key={item.href} href={item.keepsUser ? pageHref(item.href, DEMO_USER) : item.href} className="w-fit font-semibold hover:text-sun">
                  {item.label}
                </Link>
              ))}
            </nav>
            <dl className="flex flex-col gap-3 font-readout text-[12px]">
              <div>
                <dt className="text-paper/80">Network</dt>
                <dd>{networkLabel(config)}</dd>
              </div>
              <div>
                <dt className="text-paper/80">Vault</dt>
                <dd className="break-all">
                  {config.vaultId ? (
                    config.vaultId
                  ) : (
                    <>
                      <a href="https://testnet.nearblocks.io/address/vault.lifeline-team.testnet" target="_blank" rel="noreferrer noopener" className="underline decoration-sun underline-offset-4 hover:text-sun">
                        vault.lifeline-team.testnet
                      </a>{" "}
                      on testnet, mainnet-ready
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-paper/80">Demo</dt>
                <dd>
                  <Link href={pageHref("/position", DEMO_USER)} className="underline decoration-sun underline-offset-4 hover:text-sun">
                    {DEMO_USER}
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="text-paper/80">Source</dt>
                <dd>
                  <a href="https://github.com/Prashant-thakur77/LifeLine" className="underline decoration-sun underline-offset-4 hover:text-sun" target="_blank" rel="noreferrer noopener">
                    GitHub (MIT)
                  </a>
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </footer>
  );
}
