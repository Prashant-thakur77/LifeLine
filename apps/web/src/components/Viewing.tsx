"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { DEMO_USER, keeperUrlFor } from "../lib/config";
import { isNearAccount } from "../lib/accounts";
import { config } from "../lib/env";
import { keeper, type KeeperInfo } from "../lib/keeper";
import { pageHref } from "../lib/links";
import { usePoll } from "../hooks/usePoll";
import { Badge, Button, ButtonLink, Card, Field, inputClass } from "./ui";
import { useWallet } from "./WalletProvider";

/** The account a page shows: ?user= first, then the connected wallet, else nobody. */
export function useViewedUser(): { user: string | null; fromWallet: boolean } {
  const params = useSearchParams();
  const { accountId } = useWallet();
  const fromQuery = params.get("user")?.trim().toLowerCase() || null;
  if (fromQuery) return { user: fromQuery, fromWallet: fromQuery === accountId };
  return { user: accountId, fromWallet: accountId !== null };
}

/**
 * Whether what's on screen is the simulation: the demo account always is, and so is
 * any account when the dashboard points at a keeper running in sim mode.
 */
export function useIsSimulation(user: string | null): { simulation: boolean; keeperBase: string; info: KeeperInfo | undefined } {
  const keeperBase = user ? keeperUrlFor(config, user) : config.keeperApiUrl;
  const info = usePoll(`info:${keeperBase}`, () => keeper.info(keeperBase), 60_000);
  return { simulation: user === DEMO_USER || info.data?.mode === "sim", keeperBase, info: info.data };
}

export function SimBanner({ compact = false }: { compact?: boolean }) {
  return (
    <div className="mb-6 flex items-start gap-3 rounded-lg border-2 border-ink bg-[#ece6ff] px-4 py-3 text-[14px] leading-relaxed text-ink-2">
      <Badge tone="sim" className="mt-0.5">Simulation</Badge>
      <p className="min-w-0">
        {compact ? (
          "Simulated data from the always-on sim keeper."
        ) : (
          <>
            You&apos;re watching <span className="font-medium text-ink">{DEMO_USER}</span> on the always-on sim keeper. The ETH price and the 1Click quotes are
            live; the position, the reserve and the rescues are pretend, so nothing here moves money or appears on an explorer. About every 15 minutes the
            price drops below the trigger and the keeper rescues it.
          </>
        )}
      </p>
    </div>
  );
}

/** Shown when a page needs an account and has none. The demo is one tap away. */
export function AccountChooser({ path, purpose }: { path: string; purpose: string }) {
  const router = useRouter();
  const { status, accountId, connect } = useWallet();
  const [lookup, setLookup] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card className="relative overflow-hidden p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-sim/10 blur-3xl" aria-hidden />
        <Badge tone="sim">No wallet needed</Badge>
        <h2 className="mt-4 font-display text-[24px] leading-tight text-ink">Watch the live demo</h2>
        <p className="mt-2 text-[14.5px] leading-relaxed text-body">
          {DEMO_USER} runs on the sim keeper around the clock: a live ETH price, a position that drifts toward liquidation, and a rescue every
          quarter hour.
        </p>
        <ButtonLink href={pageHref(path, DEMO_USER)} variant="primary" size="lg" className="mt-5 w-full sm:w-auto">
          Open {DEMO_USER}
        </ButtonLink>
      </Card>
      <Card className="p-6">
        <h2 className="font-display text-[22px] leading-tight text-ink">Or use your own account</h2>
        <p className="mt-2 text-[14.5px] leading-relaxed text-body">{purpose}</p>
        {accountId ? null : (
          <Button
            variant="secondary"
            className="mt-4 w-full sm:w-auto"
            disabled={status !== "ready"}
            onClick={() => connect().catch(() => undefined)}
          >
            Connect a NEAR wallet
          </Button>
        )}
        <form
          className="mt-5"
          onSubmit={(event) => {
            event.preventDefault();
            const account = lookup.trim().toLowerCase();
            if (!isNearAccount(account)) {
              setError("That isn't a NEAR account name, like alice.near.");
              return;
            }
            router.push(pageHref(path, account));
          }}
        >
          <Field label="Look up any account" htmlFor="lookup" error={error}>
            <div className="flex gap-2">
              <input
                id="lookup"
                className={inputClass}
                placeholder="alice.near"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={lookup}
                aria-invalid={error ? true : undefined}
                onChange={(e) => {
                  setLookup(e.target.value);
                  setError(null);
                }}
              />
              <Button type="submit" variant="secondary" className="h-11">
                View
              </Button>
            </div>
          </Field>
        </form>
      </Card>
    </div>
  );
}
