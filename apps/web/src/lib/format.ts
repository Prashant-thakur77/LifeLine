// Display formatting. Token amounts stay in base units as strings and go through BigInt,
// so no amount of money ever passes through a float on its way to the screen or a wallet.

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return usd.format(value);
}

/** Health with two decimals. No positions reads as ∞; a missing reading as a dash. */
export function formatHealth(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (value === Number.POSITIVE_INFINITY) return "∞";
  return value.toFixed(2);
}

/** A market price: cents above 100, more precision below, so a 0.0003 coin isn't "0.00". */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 100) return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 1) return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return value.toLocaleString("en-US", { maximumSignificantDigits: 6 });
}

const groupThousands = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * Base units to a readable amount, rounded half up to `maxFraction` places:
 * formatUnits("3469653", 6) is "3.47". Anything that isn't a whole number reads "—".
 */
export function formatUnits(base: string, decimals: number, maxFraction = 2): string {
  if (!/^\d+$/.test(base)) return "—";
  const value = BigInt(base);
  const fraction = Math.min(maxFraction, decimals);
  const drop = decimals - fraction;
  let scaled = value;
  if (drop > 0) {
    const divisor = 10n ** BigInt(drop);
    scaled = (value + divisor / 2n) / divisor;
  }
  const unit = 10n ** BigInt(fraction);
  const whole = groupThousands((scaled / unit).toString());
  if (fraction === 0) return whole;
  return `${whole}.${(scaled % unit).toString().padStart(fraction, "0")}`;
}

export type ParsedUnits = { ok: true; base: string } | { ok: false; error: string };

/** "2.5" with 6 decimals is "2500000". Refuses more decimals than the token has. */
export function parseUnits(text: string, decimals: number): ParsedUnits {
  const trimmed = text.trim();
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return { ok: false, error: "Enter a number, like 10 or 2.5." };
  const [whole = "", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    return { ok: false, error: decimals === 0 ? "This token has no decimal places." : `At most ${decimals} decimal places.` };
  }
  const scale = 10n ** BigInt(decimals);
  const base = BigInt(whole || "0") * scale + BigInt(fraction.padEnd(decimals, "0") || "0");
  return { ok: true, base: base.toString() };
}

/** Rescue latency: tenths of a second when short, whole seconds, then minutes. */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** "12 s ago". A time in the future, from a skewed clock, reads "just now". */
export function timeAgo(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const seconds = Math.floor((nowMs - at) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

/** m:ss until a deadline, never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Shortens long addresses in the middle: 0x1111…1111. Short ones stay whole. */
export function shortMiddle(text: string, head = 6, tail = 4): string {
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** Cooldown and similar: "2 min", "90 s", "1 h". */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60 || seconds % 60 !== 0) return `${seconds} s`;
  if (seconds < 3600 || seconds % 3600 !== 0) return `${seconds / 60} min`;
  return `${seconds / 3600} h`;
}
