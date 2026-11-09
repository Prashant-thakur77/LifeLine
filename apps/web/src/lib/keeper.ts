import type {
  AttestationResponse,
  AuditResponse,
  HealthResponse,
  StatsResponse,
  TelegramLinkResponse,
} from "@lifeline/shared";
import type { ProvedRecord } from "./answer-proof";

// The keeper's REST API (apps/keeper/src/api.ts). Errors come back as { error } with an
// HTTP status; KeeperError turns each into something a user can act on.

export type KeeperErrorKind = "unreachable" | "not-watched" | "no-bot" | "rate-limited" | "bad-request" | "server";

export class KeeperError extends Error {
  constructor(
    readonly kind: KeeperErrorKind,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "KeeperError";
  }
}

/** Maps a failed response to a KeeperError with a plain-language message. */
export function keeperError(status: number, body: unknown): KeeperError {
  const said = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : null;
  if (status === 404 && said?.includes("watched")) {
    return new KeeperError("not-watched", status, "The keeper isn't watching this account. Set a policy first, or check the account name.");
  }
  if (status === 503 && said?.toLowerCase().includes("telegram")) {
    return new KeeperError("no-bot", status, "This keeper has no Telegram bot set up, so it can't issue link codes.");
  }
  if (status === 429) {
    return new KeeperError("rate-limited", status, said ? `${said[0]!.toUpperCase()}${said.slice(1)}.` : "Too many requests. Try again in a few minutes.");
  }
  if (status >= 400 && status < 500) {
    return new KeeperError("bad-request", status, said ? `The keeper refused the request: ${said}.` : `The keeper refused the request (HTTP ${status}).`);
  }
  return new KeeperError("server", status, `The keeper had a problem (HTTP ${status}). Try again shortly.`);
}

/** As apps/keeper/src/attack-lab.ts serves them. */
export type LabAttack = { id: string; title: string; move: string; expect: string };
export type AttackResult = { id: string; at: string; txHash: string; refused: boolean; answer: string; expected: string };
export type LabInfo = {
  open: boolean;
  target: { vault: string; keeper: string; user: string; token: string; hlAddress: string; maxPerRescue: string; usedDeposit: string };
  attacks: LabAttack[];
  recent: AttackResult[];
};

/** GET / on the keeper Worker: which mode it runs in and when it last ticked. */
export type KeeperInfo = {
  service: string;
  mode: "sim" | "live";
  network: "mainnet" | "testnet";
  version?: string;
  watching?: number;
  startedAt?: string;
  lastTickAt?: string | null;
  nextAlarmAt?: string | null;
};

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new KeeperError("unreachable", null, "Couldn't reach the keeper. It may be restarting, or your connection dropped.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw keeperError(response.status, body);
  return body as T;
}

const enc = encodeURIComponent;

export const keeper = {
  info: (base: string) => request<KeeperInfo>(base, "/"),
  health: (base: string, user: string) => request<HealthResponse>(base, `/api/health/${enc(user)}`),
  audit: (base: string, user: string, limit = 100) => request<AuditResponse>(base, `/api/audit?user=${enc(user)}&limit=${limit}`),
  ledger: (base: string, limit = 200) => request<AuditResponse>(base, `/api/ledger?limit=${limit}`),
  stats: (base: string) => request<StatsResponse>(base, "/api/stats"),
  attestation: (base: string) => request<AttestationResponse>(base, "/api/attestation"),
  /** A record with the bytes and signature behind its model words; "latest" for the newest one. */
  proof: (base: string, recordId: string, user?: string) =>
    request<ProvedRecord>(base, `/api/proof/${enc(recordId)}${user ? `?user=${enc(user)}` : ""}`),
  /** The public attack lab on the demo keeper: its target, its attacks and the latest results. */
  lab: (base: string) => request<LabInfo>(base, "/api/lab"),
  /** Sends one lab attack to the testnet vault; resolves with the vault's answer. */
  attack: (base: string, attack: string) =>
    request<AttackResult>(base, "/api/lab/attack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attack }) }),
  telegramLink: (base: string, user: string) =>
    request<TelegramLinkResponse>(base, "/api/telegram/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user }),
    }),
};
