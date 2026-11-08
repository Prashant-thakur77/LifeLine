"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { DEMO_USER } from "../lib/config";
import { config } from "../lib/env";
import { shortMiddle } from "../lib/format";
import { pageHref } from "../lib/links";
import { describeTxError } from "../lib/tx";
import { Button, cx, Spinner } from "./ui";
import { useWallet } from "./WalletProvider";

/** A lifebuoy: the mark. Paper ring, four signal-orange quarters. */
export function Mark({ className }: { className?: string }) {
  const c = 2 * Math.PI * 8.5;
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="#f5f1e8" strokeWidth="5" />
      <circle
        cx="12"
        cy="12"
        r="8.5"
        fill="none"
        stroke="#ff7a3d"
        strokeWidth="5"
        strokeDasharray={`${c / 8} ${c / 8}`}
        transform="rotate(-22.5 12 12)"
      />
    </svg>
  );
}

const NAV = [
  { href: "/position", label: "Position", keepsUser: true },
  { href: "/history", label: "History", keepsUser: true },
  { href: "/ledger", label: "Ledger", keepsUser: false },
  { href: "/fund", label: "Fund", keepsUser: false },
  { href: "/start", label: "Set up", keepsUser: false },
  { href: "/telegram", label: "Alerts", keepsUser: false },
] as const;

function NavLinks({ className }: { className?: string }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const user = params.get("user");
  return (
    <nav className={className} aria-label="Main">
      {NAV.map((item) => {
        const active = pathname === item.href || pathname === `${item.href}/`;
        return (
          <Link
            key={item.href}
            href={item.keepsUser ? pageHref(item.href, user) : item.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "shrink-0 px-3 py-1.5 text-[14px] font-medium transition-colors",
              active ? "text-paper shadow-[inset_0_-3px_0_var(--color-rescue)]" : "text-mist-300 hover:text-paper hover:shadow-[inset_0_-3px_0_var(--color-ink-500)]",
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
      <Button size="sm" variant="secondary" disabled>
        <Spinner className="size-3.5" /> Wallet
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
          <p role="alert" className="absolute right-0 top-10 z-30 w-64 rounded-lg border border-danger/40 bg-ink-800 p-3 text-[13px] text-mist-200 shadow-xl">
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
        className="flex h-8 max-w-[170px] items-center gap-2 rounded-xl border border-ink-500 bg-ink-750 px-3 text-[13px] font-medium text-paper hover:border-mist-400"
      >
        <span className="size-2 shrink-0 rounded-full bg-safe" aria-hidden />
        <span className="truncate">{shortMiddle(accountId, 10, 6)}</span>
      </button>
      {open ? (
        <div className="absolute right-0 top-10 z-30 w-56 overflow-hidden rounded-xl border border-ink-500 bg-ink-800 shadow-2xl">
          <p className="truncate border-b border-ink-600 px-4 py-3 text-[12px] text-mist-400">
            Signed in as <span className="text-mist-100">{accountId}</span>
          </p>
          <Link href={pageHref("/position", accountId)} onClick={() => setOpen(false)} className="block px-4 py-2.5 text-[14px] text-mist-100 hover:bg-ink-700">
            My position
          </Link>
          <Link href={pageHref("/history", accountId)} onClick={() => setOpen(false)} className="block px-4 py-2.5 text-[14px] text-mist-100 hover:bg-ink-700">
            My history
          </Link>
          <button
            type="button"
            onClick={async () => {
              setOpen(false);
              await disconnect();
            }}
            className="block w-full px-4 py-2.5 text-left text-[14px] text-[#ff8a98] hover:bg-ink-700"
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
    <header className="sticky top-0 z-20 border-b border-ink-700/80 bg-ink-900/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Lifeline home">
          <Mark className="size-6" />
          <span className="font-stencil text-[21px] font-bold uppercase leading-none tracking-[0.02em] text-paper">Lifeline</span>
        </Link>
        <Suspense fallback={<div className="hidden flex-1 md:block" />}>
          <NavLinks className="hidden flex-1 items-center gap-1 md:flex" />
        </Suspense>
        <div className="ml-auto md:ml-0">
          <WalletButton />
        </div>
      </div>
      <Suspense fallback={<div className="h-11 md:hidden" />}>
        <NavLinks className="scrollbar-none flex h-11 items-center gap-1 overflow-x-auto border-t border-ink-700/60 px-3 [mask-image:linear-gradient(to_right,black_88%,transparent)] md:hidden" />
      </Suspense>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mt-20 border-t border-ink-700/70">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-[13px] text-mist-400 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-2.5">
          <Mark className="size-4" />
          <span>Lifeline: auto top-up for onchain perps, funded from any chain.</span>
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-1">
          <div className="flex gap-1.5">
            <dt>Network</dt>
            <dd className="text-mist-200">{config.network}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>Vault</dt>
            <dd className="text-mist-200">{config.vaultId ?? "not deployed yet"}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>Demo</dt>
            <dd>
              <Link href={pageHref("/position", DEMO_USER)} className="text-mist-200 hover:text-paper">
                {DEMO_USER}
              </Link>
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt>Source</dt>
            <dd>
              <a href="https://github.com/Prashant-thakur77/LifeLine" className="text-mist-200 hover:text-paper" target="_blank" rel="noreferrer noopener">
                GitHub (MIT)
              </a>
            </dd>
          </div>
        </dl>
      </div>
    </footer>
  );
}
