"use client";

import type { TelegramLinkResponse } from "@lifeline/shared";
import { useState } from "react";
import { useNow } from "../hooks/usePoll";
import { DEMO_USER } from "../lib/config";
import { formatCountdown } from "../lib/format";
import { KeeperError, keeper } from "../lib/keeper";
import { telegramStart } from "../lib/links";
import { AccountChooser, SimBanner, useIsSimulation, useViewedUser } from "./Viewing";
import { Button, ButtonLink, Card, CopyButton, Notice, PageHeader } from "./ui";

export function TelegramView() {
  const { user } = useViewedUser();
  return (
    <>
      <PageHeader eyebrow="Alerts" title="Hear about it on Telegram">
        The bot messages you when health crosses your warn line and for every rescue, with the same explanation as your history. It can also show your
        health and pause rescues from the chat.
      </PageHeader>
      {user ? <LinkCard key={user} user={user} /> : <AccountChooser path="/telegram" purpose="Connect your NEAR wallet to link alerts for your own account." />}
    </>
  );
}

function LinkCard({ user }: { user: string }) {
  const { simulation, keeperBase } = useIsSimulation(user);
  const [link, setLink] = useState<TelegramLinkResponse | null>(null);
  const [error, setError] = useState<KeeperError | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      setLink(await keeper.telegramLink(keeperBase, user));
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(false);
    }
  };

  const remaining = link ? Date.parse(link.expiresAt) - now : 0;
  const expired = link !== null && remaining <= 0;

  return (
    <>
      {simulation ? <SimBanner compact /> : null}
      <Card className="max-w-2xl p-6">
        <p className="text-[14px] text-mist-300">
          Linking alerts for <span className="font-semibold text-paper">{user}</span>
        </p>

        {link && !expired ? (
          <div className="mt-5">
            <p className="text-[13px] text-mist-400">Your one-time code</p>
            <p className="num mt-1 select-all text-[34px] tracking-[0.18em] text-paper sm:text-[40px]">{link.code}</p>
            <p className="mt-1 text-[13px] text-mist-400">
              Expires in <span className="num text-mist-200">{formatCountdown(remaining)}</span>. It works once.
            </p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <a
                href={telegramStart(link.botUsername, link.code)}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-11 items-center justify-center rounded-xl bg-rescue px-5 text-[15px] font-semibold text-ink-950 hover:bg-[#ff8c55]"
              >
                Open @{link.botUsername}
              </a>
              <CopyButton value={link.code} label="Copy code" />
            </div>
            <p className="mt-4 text-[13.5px] leading-relaxed text-mist-300">
              The button opens the bot with the code filled in: tap Start. Or open <span className="text-paper">@{link.botUsername}</span> yourself and send
              it the code. Send <span className="num">/unlink</span> there to stop.
            </p>
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-3">
            {expired ? <Notice tone="warn" title="That code expired">Get a new one; each lasts a few minutes.</Notice> : null}
            <Button variant="primary" className="self-start" busy={busy} onClick={request}>
              {expired ? "Get a new code" : "Get a link code"}
            </Button>
          </div>
        )}

        {error ? (
          <div className="mt-4">
            {error instanceof KeeperError && error.kind === "no-bot" ? (
              <Notice tone="info" title="No bot on this keeper">
                {user === DEMO_USER
                  ? "The sim keeper doesn't run a Telegram bot, so the demo account can't be linked. On the real keeper, this gives you a code for the bot."
                  : error.message}
              </Notice>
            ) : error instanceof KeeperError && error.kind === "not-watched" ? (
              <Notice tone="warn" title="The keeper isn't watching this account" action={<ButtonLink href="/start" variant="primary" size="sm">Set up protection</ButtonLink>}>
                Alerts follow the accounts the keeper watches. Set a policy first.
              </Notice>
            ) : (
              <Notice tone="danger" title="Couldn't get a code">
                {error.message}
              </Notice>
            )}
          </div>
        ) : null}
      </Card>
    </>
  );
}
