"use client";

import type { NearConnector } from "@hot-labs/near-connect";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { config } from "../lib/env";
import type { Outcome } from "../lib/near-rpc";
import type { Transaction } from "../lib/vault";

export type WalletStatus = "loading" | "ready" | "unavailable";

type WalletContextValue = {
  status: WalletStatus;
  accountId: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Asks the wallet to sign and send. Resolves with the final outcome, or throws. */
  send: (tx: Transaction) => Promise<Outcome>;
};

const WalletContext = createContext<WalletContextValue | null>(null);

/**
 * HOT's near-connect, which runs each wallet's code in a sandboxed iframe. It loads in
 * the browser only, once the page is up and idle, so the static pages never wait on it.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const connectorRef = useRef<NearConnector | null>(null);
  const [status, setStatus] = useState<WalletStatus>("loading");
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Started at the browser's first idle moment, so it never competes with the page's
    // first frames and animations. The header shows "Connect wallet" meanwhile.
    const start = async () => {
      try {
        const { NearConnector } = await import("@hot-labs/near-connect");
        if (cancelled) return;
        const connector = new NearConnector({
          network: config.network,
          providers: { [config.network]: [config.rpcUrl] },
          features: { signAndSendTransaction: true },
        });
        connectorRef.current = connector;
        connector.on("wallet:signIn", (event) => {
          if (!cancelled) setAccountId(event.accounts[0]?.accountId ?? null);
        });
        connector.on("wallet:signOut", () => {
          if (!cancelled) setAccountId(null);
        });
        await connector.whenManifestLoaded.catch(() => undefined);
        const restored = await connector.getConnectedWallet().catch(() => null);
        if (cancelled) return;
        setAccountId(restored?.accounts[0]?.accountId ?? null);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    };
    const idle = typeof window.requestIdleCallback === "function";
    const handle = idle ? window.requestIdleCallback(() => void start(), { timeout: 2000 }) : window.setTimeout(() => void start(), 600);
    return () => {
      cancelled = true;
      if (idle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
      connectorRef.current?.removeAllListeners();
    };
  }, []);

  const connect = useCallback(async () => {
    const connector = connectorRef.current;
    if (!connector) throw new Error("The wallet connector hasn't loaded yet.");
    const wallet = await connector.connect();
    const accounts = await wallet.getAccounts({ network: config.network });
    setAccountId(accounts[0]?.accountId ?? null);
  }, []);

  const disconnect = useCallback(async () => {
    const connector = connectorRef.current;
    if (!connector) return;
    await connector.disconnect().catch(() => undefined);
    setAccountId(null);
  }, []);

  const send = useCallback(
    async (tx: Transaction): Promise<Outcome> => {
      const connector = connectorRef.current;
      if (!connector || !accountId) throw new Error("Connect a wallet first.");
      const wallet = await connector.wallet();
      const outcome = await wallet.signAndSendTransaction({
        network: config.network,
        signerId: accountId,
        receiverId: tx.receiverId,
        actions: tx.actions,
      });
      return outcome as Outcome;
    },
    [accountId],
  );

  const value = useMemo(() => ({ status, accountId, connect, disconnect, send }), [status, accountId, connect, disconnect, send]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet needs a WalletProvider");
  return value;
}
