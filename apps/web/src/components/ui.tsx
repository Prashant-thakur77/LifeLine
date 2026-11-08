"use client";

import Link from "next/link";
import { useState, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Card({ className, children, ...rest }: ComponentProps<"section">) {
  return (
    <section className={cx("rounded-2xl border border-ink-600/70 bg-ink-800/70 backdrop-blur-sm", className)} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({ title, eyebrow, action }: { title: ReactNode; eyebrow?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-5">
      <div className="min-w-0">
        {eyebrow ? <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-mist-400">{eyebrow}</p> : null}
        <h2 className="text-[15px] font-semibold text-paper">{title}</h2>
      </div>
      {action}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-rescue text-ink-950 hover:bg-[#ff8c55] disabled:bg-ink-600 disabled:text-mist-400",
  secondary: "border border-ink-500 bg-ink-750 text-mist-100 hover:border-mist-400 hover:bg-ink-700 disabled:text-mist-400 disabled:hover:border-ink-500",
  ghost: "text-mist-200 hover:bg-ink-700 hover:text-paper disabled:text-mist-400",
  danger: "border border-danger/50 bg-danger/10 text-[#ff8a98] hover:bg-danger/20 disabled:opacity-50",
};

const SIZE = { sm: "h-8 px-3 text-[13px]", md: "h-10 px-4 text-sm", lg: "h-12 px-5 text-[15px]" } as const;

export function Button({
  variant = "secondary",
  size = "md",
  busy = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: keyof typeof SIZE; busy?: boolean }) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed",
        BUTTON[variant],
        SIZE[size],
        className,
      )}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner className="size-4" /> : null}
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  variant = "secondary",
  size = "md",
  className,
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: keyof typeof SIZE;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={cx("inline-flex shrink-0 items-center justify-center gap-2 rounded-xl font-semibold transition-colors", BUTTON[variant], SIZE[size], className)}>
      {children}
    </Link>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("animate-spin", className ?? "size-4")} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export type Tone = "neutral" | "safe" | "warn" | "rescue" | "danger" | "sim" | "info";

const BADGE: Record<Tone, string> = {
  neutral: "border-ink-500 bg-ink-700/60 text-mist-200",
  safe: "border-safe/40 bg-safe/10 text-safe",
  warn: "border-warn/40 bg-warn/10 text-warn",
  rescue: "border-rescue/45 bg-rescue/10 text-rescue",
  danger: "border-danger/45 bg-danger/10 text-[#ff8a98]",
  sim: "border-sim/45 bg-sim/10 text-sim",
  info: "border-mist-400/40 bg-mist-400/10 text-mist-200",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em]", BADGE[tone], className)}>
      {children}
    </span>
  );
}

const NOTICE: Record<Tone, string> = {
  neutral: "border-ink-500 bg-ink-750/80 text-mist-200",
  info: "border-ink-500 bg-ink-750/80 text-mist-200",
  safe: "border-safe/35 bg-safe/[0.07] text-mist-100",
  warn: "border-warn/40 bg-warn/[0.07] text-mist-100",
  rescue: "border-rescue/40 bg-rescue/[0.07] text-mist-100",
  danger: "border-danger/45 bg-danger/[0.08] text-mist-100",
  sim: "border-sim/40 bg-sim/[0.07] text-mist-100",
};

const NOTICE_DOT: Record<Tone, string> = {
  neutral: "bg-mist-400",
  info: "bg-mist-300",
  safe: "bg-safe",
  warn: "bg-warn",
  rescue: "bg-rescue",
  danger: "bg-danger",
  sim: "bg-sim",
};

export function Notice({ tone = "info", title, children, action, className }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("flex gap-3 rounded-xl border px-4 py-3 text-sm leading-relaxed", NOTICE[tone], className)}>
      <span className={cx("mt-[7px] size-2 shrink-0 rounded-full", NOTICE_DOT[tone])} aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold text-paper">{title}</p> : null}
        {children ? <div className={cx(title ? "mt-0.5" : "", "text-mist-200 [&_a]:text-paper [&_a]:underline [&_a]:decoration-ink-500 [&_a]:underline-offset-2")}>{children}</div> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-lg bg-ink-700/70", className)} aria-hidden />;
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cx("inline-flex items-center gap-1 underline decoration-ink-500 underline-offset-[3px] hover:decoration-mist-300", className)}>
      {children}
      <svg viewBox="0 0 12 12" className="size-2.5 opacity-70" aria-hidden>
        <path d="M4 2h6v6M10 2 3 9" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      </svg>
    </a>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-mist-200">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[13px] text-[#ff8a98]" id={`${htmlFor}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12.5px] leading-relaxed text-mist-400">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputClass =
  "h-11 w-full min-w-0 rounded-xl border border-ink-500 bg-ink-850 px-3.5 text-[15px] text-paper placeholder:text-mist-400 outline-none transition-colors focus:border-rescue/70 focus:ring-2 focus:ring-rescue/20 aria-[invalid=true]:border-danger/60";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

/** A label and a value, for the stat rows on the position page. */
export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "safe" | "warn" | "rescue" | "danger" }) {
  const color = tone === "safe" ? "text-safe" : tone === "warn" ? "text-warn" : tone === "rescue" ? "text-rescue" : tone === "danger" ? "text-[#ff8a98]" : "text-paper";
  return (
    <div className="min-w-0">
      <p className="text-[12px] text-mist-400">{label}</p>
      <p className={cx("num mt-0.5 truncate text-[17px] font-medium", color)}>{value}</p>
      {sub ? <p className="mt-0.5 text-[12px] text-mist-400">{sub}</p> : null}
    </div>
  );
}

export function PageHeader({ eyebrow, title, children, aside }: { eyebrow?: ReactNode; title: ReactNode; children?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <p className="mb-2 text-[12px] font-medium uppercase tracking-[0.16em] text-rescue">{eyebrow}</p> : null}
        <h1 className="font-display text-[30px] leading-[1.1] font-medium tracking-[-0.01em] text-paper break-words sm:text-[38px]">{title}</h1>
        {children ? <div className="mt-3 max-w-2xl text-[15px] leading-relaxed text-mist-300">{children}</div> : null}
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </header>
  );
}
