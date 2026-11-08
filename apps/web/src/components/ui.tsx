"use client";

import Link from "next/link";
import { useState, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Card({ className, children, ...rest }: ComponentProps<"section">) {
  return (
    <section className={cx("rounded-xl border-2 border-ink bg-card shadow-[4px_4px_0_var(--color-ink)]", className)} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({ title, eyebrow, action }: { title: ReactNode; eyebrow?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-5">
      <div className="min-w-0">
        {eyebrow ? <p className="mb-1 font-readout text-[10.5px] uppercase tracking-[0.1em] text-muted">{eyebrow}</p> : null}
        <h2 className="text-[17px] font-bold text-ink">{title}</h2>
      </div>
      {action}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** Printed, tactile buttons: ink border, an offset ink shadow that the button presses into. */
const PRESS =
  "border-2 border-ink shadow-[3px_3px_0_var(--color-ink)] transition-[transform,box-shadow,background-color] duration-150 hover:-translate-x-px hover:-translate-y-px hover:shadow-[4px_4px_0_var(--color-ink)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-[1px_1px_0_var(--color-ink)] disabled:translate-x-0 disabled:translate-y-0 disabled:shadow-none";

const BUTTON: Record<ButtonVariant, string> = {
  primary: `${PRESS} bg-rescue text-ink hover:bg-[#ff6b33] disabled:border-line-strong disabled:bg-shade disabled:text-muted`,
  secondary: `${PRESS} bg-card text-ink hover:bg-paper-2 disabled:border-line-strong disabled:text-muted`,
  ghost: "text-ink-2 hover:bg-shade hover:text-ink disabled:text-muted",
  danger: `${PRESS} bg-[#ffe1e4] text-danger-ink hover:bg-[#ffd0d5] disabled:opacity-50`,
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
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-bold disabled:cursor-not-allowed",
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
    <Link href={href} className={cx("inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-bold", BUTTON[variant], SIZE[size], className)}>
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
  neutral: "bg-shade text-ink",
  safe: "bg-safe text-ink",
  warn: "bg-sun text-ink",
  rescue: "bg-rescue text-ink",
  danger: "bg-danger text-paper",
  sim: "bg-sim text-paper",
  info: "bg-sea-light text-ink",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-sm border-[1.5px] border-ink px-1.5 py-0.5 font-readout text-[10.5px] uppercase tracking-[0.06em]", BADGE[tone], className)}>
      {children}
    </span>
  );
}

const NOTICE: Record<Tone, string> = {
  neutral: "bg-card text-ink-2",
  info: "bg-[#e3ebff] text-ink-2",
  safe: "bg-[#d8f5ec] text-ink",
  warn: "bg-[#fff1c9] text-ink",
  rescue: "bg-[#ffe1d4] text-ink",
  danger: "bg-[#ffe1e4] text-ink",
  sim: "bg-[#ece6ff] text-ink",
};

const NOTICE_DOT: Record<Tone, string> = {
  neutral: "bg-muted",
  info: "bg-muted",
  safe: "bg-safe",
  warn: "bg-warn",
  rescue: "bg-rescue",
  danger: "bg-danger",
  sim: "bg-sim",
};

export function Notice({ tone = "info", title, children, action, className }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("flex gap-3 rounded-lg border-2 border-ink px-4 py-3 text-sm leading-relaxed", NOTICE[tone], className)}>
      <span className={cx("mt-[5px] size-2.5 shrink-0 rounded-full border-[1.5px] border-ink", NOTICE_DOT[tone])} aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold text-ink">{title}</p> : null}
        {children ? <div className={cx(title ? "mt-0.5" : "", "text-ink-2 [&_a]:text-ink [&_a]:underline [&_a]:decoration-line-strong [&_a]:underline-offset-2")}>{children}</div> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-md bg-shade", className)} aria-hidden />;
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cx("inline-flex items-center gap-1 underline decoration-rescue decoration-[1.5px] underline-offset-[3px] hover:text-rescue-ink", className)}>
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
      <label htmlFor={htmlFor} className="text-[13px] font-semibold text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[13px] text-danger-ink" id={`${htmlFor}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12.5px] leading-relaxed text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputClass =
  "h-11 w-full min-w-0 rounded-lg border-2 border-ink bg-card px-3.5 text-[15px] text-ink placeholder:text-muted outline-none transition-shadow focus:shadow-[3px_3px_0_var(--color-sea)] aria-[invalid=true]:border-danger aria-[invalid=true]:shadow-[3px_3px_0_var(--color-danger)]";

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
  const color = tone === "safe" ? "text-safe-ink" : tone === "warn" ? "text-warn-ink" : tone === "rescue" ? "text-rescue-ink" : tone === "danger" ? "text-danger-ink" : "text-ink";
  return (
    <div className="min-w-0">
      <p className="text-[12px] text-muted">{label}</p>
      <p className={cx("num mt-0.5 truncate text-[19px] font-medium", color)}>{value}</p>
      {sub ? <p className="mt-0.5 text-[12px] text-muted">{sub}</p> : null}
    </div>
  );
}

export function PageHeader({ eyebrow, title, children, aside }: { eyebrow?: ReactNode; title: ReactNode; children?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="relative mb-8 sm:mb-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="mb-3 inline-block rounded-sm bg-ink px-1.5 py-0.5 font-readout text-[11px] uppercase tracking-[0.08em] text-paper">{eyebrow}</p>
          ) : null}
          <h1 className="break-words text-[clamp(40px,6vw,76px)] font-extrabold uppercase leading-[0.88] tracking-[-0.01em] text-ink [font-variation-settings:'wdth'_70]">
            {title}
          </h1>
          {children ? <div className="mt-4 max-w-2xl text-[15.5px] leading-relaxed text-body">{children}</div> : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
      <PaperRule className="mt-6" />
    </header>
  );
}

/** A strip of three cut-paper waves: the divider under every page title. */
export function PaperRule({ className }: { className?: string }) {
  const wave = (top: number, amp: number, period: number) => {
    let d = `M 0 ${top}`;
    for (let x = 0; x < 1200 + period; x += period) {
      d += ` C ${x + period / 6} ${top - amp} ${x + period / 3} ${top - amp} ${x + period / 2} ${top} C ${x + (2 * period) / 3} ${top + amp} ${x + (5 * period) / 6} ${top + amp} ${x + period} ${top}`;
    }
    return `${d} L ${1200 + period * 2} 24 L 0 24 Z`;
  };
  return (
    <svg viewBox="0 0 1200 24" preserveAspectRatio="none" className={cx("block h-5 w-full", className)} aria-hidden>
      <path d={wave(10, 5, 160)} fill="#b7ccff" />
      <path d={wave(15, 4, 220)} fill="#1d4bff" />
      <path d={wave(20, 3, 140)} fill="#0e2fb3" />
    </svg>
  );
}
