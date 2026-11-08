import type { AuditRecord, HealthResponse, StatsResponse } from "@lifeline/shared";
import type { SqlDatabase } from "./sql";

const TELEGRAM_CODE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I; 32 letters, which divides 256
const TELEGRAM_CODE_LENGTH = 8;
const MAX_OPEN_TELEGRAM_CODES_PER_USER = 5;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    user TEXT NOT NULL,
    kind TEXT NOT NULL,
    request_id TEXT,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_user ON audit (user, seq);
  CREATE INDEX IF NOT EXISTS audit_kind ON audit (kind, seq);
  CREATE INDEX IF NOT EXISTS audit_request ON audit (request_id);

  CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
    BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;

  CREATE TABLE IF NOT EXISTS explanations (
    record_id TEXT PRIMARY KEY REFERENCES audit (id),
    text TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS health (
    user TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS telegram_codes (
    code TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS telegram_chats (
    chat_id INTEGER NOT NULL,
    user TEXT NOT NULL,
    PRIMARY KEY (chat_id, user)
  );
`;

type JsonRow = { json: string };
type ExplainedRow = JsonRow & { text: string | null };

const parseRaw = (row: JsonRow) => JSON.parse(row.json) as AuditRecord;
const parseRecord = (row: ExplainedRow): AuditRecord => {
  const record = parseRaw(row);
  return row.text === null ? record : { ...record, explanation: row.text };
};

const SELECT_EXPLAINED = "SELECT a.json, e.text FROM audit a LEFT JOIN explanations e ON e.record_id = a.id";

/** Each byte mod 32: since 32 divides 256, no letter comes up more often than another. */
function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TELEGRAM_CODE_LENGTH));
  return Array.from(bytes, (byte) => TELEGRAM_CODE_ALPHABET[byte % TELEGRAM_CODE_ALPHABET.length]).join("");
}

/** Nearest-rank percentile, so every answer is a latency that really happened. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? null;
}

/** The keeper's one SQLite database: the audit log, latest health and link codes. */
export class Store {
  constructor(readonly db: SqlDatabase) {
    db.exec(SCHEMA);
  }

  append(record: AuditRecord): void {
    this.db.run(
      "INSERT INTO audit (id, user, kind, request_id, json) VALUES (?, ?, ?, ?, ?)",
      record.id,
      record.user,
      record.kind,
      record.request?.id ?? null,
      JSON.stringify(record),
    );
  }

  audit(user: string, limit: number): AuditRecord[] {
    const rows = this.db.all<ExplainedRow>(`${SELECT_EXPLAINED} WHERE a.user = ? ORDER BY a.seq DESC LIMIT ?`, user, limit);
    return rows.map(parseRecord);
  }

  ledger(limit: number): AuditRecord[] {
    const rows = this.db.all<ExplainedRow>(`${SELECT_EXPLAINED} ORDER BY a.seq DESC LIMIT ?`, limit);
    return rows.map(parseRecord);
  }

  latest(user: string, kind: AuditRecord["kind"]): AuditRecord | null {
    const row = this.db.get<ExplainedRow>(`${SELECT_EXPLAINED} WHERE a.user = ? AND a.kind = ? ORDER BY a.seq DESC LIMIT 1`, user, kind);
    return row === undefined ? null : parseRecord(row);
  }

  /** The record as the keeper wrote it, for comparing with what it's about to write. */
  latestRaw(user: string, kind: AuditRecord["kind"]): AuditRecord | null {
    const row = this.db.get<JsonRow>("SELECT json FROM audit WHERE user = ? AND kind = ? ORDER BY seq DESC LIMIT 1", user, kind);
    return row === undefined ? null : parseRaw(row);
  }

  /** Rescue, block and failure records still waiting for words, oldest first. */
  unexplained(limit: number): AuditRecord[] {
    const rows = this.db.all<JsonRow>(
      `SELECT a.json FROM audit a LEFT JOIN explanations e ON e.record_id = a.id
       WHERE e.record_id IS NULL AND a.kind IN ('RESCUE_ALLOWED', 'RESCUE_DONE', 'RESCUE_BLOCKED', 'RESCUE_FAILED')
       ORDER BY a.seq LIMIT ?`,
      limit,
    );
    return rows.map(parseRaw);
  }

  /** Kept beside the record, not in it: the audit log itself can't change. */
  setExplanation(recordId: string, text: string): void {
    this.db.run(
      "INSERT INTO explanations (record_id, text) VALUES (?, ?) ON CONFLICT (record_id) DO UPDATE SET text = excluded.text",
      recordId,
      text,
    );
  }

  /** Allowed rescues with no outcome yet: after a crash, these get picked back up. */
  unfinishedRescues(): AuditRecord[] {
    const rows = this.db.all<JsonRow>(
      `SELECT json FROM audit a
       WHERE a.kind = 'RESCUE_ALLOWED' AND NOT EXISTS (
         SELECT 1 FROM audit b
         WHERE b.request_id = a.request_id AND b.kind IN ('RESCUE_DONE', 'RESCUE_FAILED')
       )
       ORDER BY a.seq`,
    );
    return rows.map(parseRaw);
  }

  stats(): StatsResponse {
    const totals = this.db.get<{ rescues: number; usd: number; blocked: number }>(
      `SELECT
         COALESCE(SUM(kind = 'RESCUE_DONE'), 0) AS rescues,
         COALESCE(SUM(CASE WHEN kind = 'RESCUE_DONE' AND json_extract(json, '$.latencyMs') IS NOT NULL
                      THEN json_extract(json, '$.request.usdNeeded') END), 0) AS usd,
         COALESCE(SUM(kind = 'RESCUE_BLOCKED'), 0) AS blocked
       FROM audit`,
    ) ?? { rescues: 0, usd: 0, blocked: 0 };
    const latencies = this.db.all<{ ms: number }>(
      `SELECT json_extract(json, '$.latencyMs') AS ms FROM audit
       WHERE kind = 'RESCUE_DONE' AND ms IS NOT NULL`,
    );
    const values = latencies.map((row) => row.ms);
    return {
      totalRescues: totals.rescues,
      totalUsdRescued: Math.round(totals.usd * 100) / 100,
      blockedCount: totals.blocked,
      latencyP50Ms: percentile(values, 50),
      latencyP95Ms: percentile(values, 95),
    };
  }

  saveHealth(user: string, response: HealthResponse): void {
    this.db.run(
      "INSERT INTO health (user, json) VALUES (?, ?) ON CONFLICT (user) DO UPDATE SET json = excluded.json",
      user,
      JSON.stringify(response),
    );
  }

  health(user: string): HealthResponse | null {
    const row = this.db.get<JsonRow>("SELECT json FROM health WHERE user = ?", user);
    return row === undefined ? null : (JSON.parse(row.json) as HealthResponse);
  }

  /** Each user keeps only their newest few, and only watched users get here, so this can't fill the disk. */
  createTelegramCode(user: string, now: Date): { code: string; expiresAt: string } {
    this.db.run("DELETE FROM telegram_codes WHERE expires_at <= ?", now.toISOString());

    const code = randomCode();
    const expiresAt = new Date(now.getTime() + TELEGRAM_CODE_TTL_MS).toISOString();
    this.db.run("INSERT INTO telegram_codes (code, user, expires_at) VALUES (?, ?, ?)", code, user, expiresAt);
    this.db.run(
      `DELETE FROM telegram_codes WHERE user = ? AND rowid NOT IN (
         SELECT rowid FROM telegram_codes WHERE user = ? ORDER BY rowid DESC LIMIT ?
       )`,
      user,
      user,
      MAX_OPEN_TELEGRAM_CODES_PER_USER,
    );
    return { code, expiresAt };
  }

  /** One use only: the code is gone whether or not it was still good. */
  consumeTelegramCode(code: string, chatId: number, now: Date): string | null {
    return this.db.transaction(() => {
      const row = this.db.get<{ user: string; expires_at: string }>(
        "DELETE FROM telegram_codes WHERE code = ? RETURNING user, expires_at",
        code,
      );
      if (row === undefined || row.expires_at <= now.toISOString()) return null;
      this.db.run("INSERT OR IGNORE INTO telegram_chats (chat_id, user) VALUES (?, ?)", chatId, row.user);
      return row.user;
    });
  }

  chatsFor(user: string): number[] {
    const rows = this.db.all<{ chat: number }>("SELECT chat_id AS chat FROM telegram_chats WHERE user = ?", user);
    return rows.map((row) => row.chat);
  }

  usersForChat(chatId: number): string[] {
    const rows = this.db.all<{ user: string }>("SELECT user FROM telegram_chats WHERE chat_id = ?", chatId);
    return rows.map((row) => row.user);
  }

  unlinkChat(chatId: number): number {
    // Counted from RETURNING: Cloudflare's rowsWritten also counts index updates.
    return this.db.all("DELETE FROM telegram_chats WHERE chat_id = ? RETURNING user", chatId).length;
  }

  close(): void {
    this.db.close();
  }
}
