"use client";

import { useCallback, useState } from "react";
import { config } from "../lib/env";
import { nearblocksTx } from "../lib/links";
import type { Outcome } from "../lib/near-rpc";
import { describeTxError, txResult } from "../lib/tx";
import type { Transaction } from "../lib/vault";
import { ExternalLink, Notice } from "./ui";
import { useWallet } from "./WalletProvider";

export type TxState =
  | { phase: "idle" }
  | { phase: "signing" }
  | { phase: "done"; hash: string | null; note?: string }
  | { phase: "failed"; hash: string | null; error: string };

/**
 * Sends one transaction through the wallet and keeps its state for the UI. `check` can
 * turn a success the wallet reports into a failure, like a deposit that bounced back.
 */
export function useTx() {
  const { send } = useWallet();
  const [state, setState] = useState<TxState>({ phase: "idle" });

  const run = useCallback(
    async (tx: Transaction, check?: (outcome: Outcome) => string | null, successNote?: string): Promise<boolean> => {
      setState({ phase: "signing" });
      try {
        const outcome = await send(tx);
        const { hash, failure } = txResult(outcome);
        const problem = failure ?? check?.(outcome) ?? null;
        if (problem) {
          setState({ phase: "failed", hash, error: problem });
          return false;
        }
        setState({ phase: "done", hash, ...(successNote ? { note: successNote } : {}) });
        return true;
      } catch (error) {
        const message = describeTxError(error);
        setState(message === null ? { phase: "idle" } : { phase: "failed", hash: null, error: message });
        return false;
      }
    },
    [send],
  );

  const reset = useCallback(() => setState({ phase: "idle" }), []);
  return { state, run, reset, busy: state.phase === "signing" };
}

export function TxStatus({ state, doneTitle }: { state: TxState; doneTitle: string }) {
  if (state.phase === "idle") return null;
  if (state.phase === "signing") {
    return <Notice tone="info" title="Waiting for your wallet">Confirm the transaction in your wallet. This page updates once it lands.</Notice>;
  }
  const link = state.hash ? (
    <ExternalLink href={nearblocksTx(state.hash, config.network)}>View on NearBlocks</ExternalLink>
  ) : null;
  if (state.phase === "done") {
    return (
      <Notice tone="safe" title={doneTitle}>
        {state.note ? <p>{state.note}</p> : null}
        {link}
      </Notice>
    );
  }
  return (
    <Notice tone="danger" title="That didn't go through">
      <p>{state.error}</p>
      {link}
    </Notice>
  );
}
