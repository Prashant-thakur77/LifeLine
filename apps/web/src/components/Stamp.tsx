import { cx } from "./ui";

export type StampKind = "proven" | "trusted" | "failed" | "checking" | "error" | "refused" | "accepted" | "sending";

const STAMP: Record<StampKind, { label: string; className: string }> = {
  proven: { label: "Proven", className: "text-safe-ink -rotate-3" },
  trusted: { label: "Trusted", className: "text-warn-ink rotate-2" },
  failed: { label: "Failed", className: "text-danger-ink -rotate-2" },
  checking: { label: "Checking", className: "text-muted animate-pulse" },
  error: { label: "No answer", className: "text-muted rotate-1" },
  refused: { label: "Refused", className: "text-danger-ink -rotate-3" },
  accepted: { label: "Accepted", className: "text-danger-ink rotate-2" },
  sending: { label: "Sending", className: "text-muted animate-pulse" },
};

/** A rubber stamp: a verdict, inked on the card. */
export function Stamp({ kind, className }: { kind: StampKind; className?: string }) {
  const { label, className: tone } = STAMP[kind];
  return (
    <span
      className={cx(
        "inline-block shrink-0 rounded-[3px] border-[2.5px] border-current px-2 py-0.5 font-readout text-[12px] font-semibold uppercase tracking-[0.16em] [box-shadow:inset_0_0_0_1.5px_var(--color-card),inset_0_0_0_3px_currentColor]",
        tone,
        className,
      )}
    >
      {label}
    </span>
  );
}
