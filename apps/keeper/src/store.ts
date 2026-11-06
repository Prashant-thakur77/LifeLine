import { randomInt } from "node:crypto";
import type { AuditRecord, HealthResponse, StatsResponse } from "@lifeline/shared";
import Database from "better-sqlite3";

const TELEGRAM_CODE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
const TELEGRAM_CODE_LENGTH = 8;

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

  CREATE TABLE IF NOT EXISTS health (
    user TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS telegram_codes (
    code TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`;

type JsonRow = { json: string };
const parseRecord = (row: JsonRow) => JSON.parse(row.json) as AuditRecord;

/** Nearest-rank percentile, so every answer is a latency that really happened. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? null;
}

/** The keeper's one SQLite file: the audit log, latest health and link codes. */
export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  append(record: AuditRecord): void {
    this.db
      .prepare("INSERT INTO audit (id, user, kind, request_id, json) VALUES (?, ?, ?, ?, ?)")
      .run(record.id, record.user, record.kind, record.request?.id ?? null, JSON.stringify(record));
  }

  audit(user: string, limit: number): AuditRecord[] {
    const rows = this.db
      .prepare("SELECT json FROM audit WHERE user = ? ORDER BY seq DESC LIMIT ?")
      .all(user, limit) as JsonRow[];
    return rows.map(parseRecord);
  }

  ledger(limit: number): AuditRecord[] {
    const rows = this.db.prepare("SELECT json FROM audit ORDER BY seq DESC LIMIT ?").all(limit) as JsonRow[];
    return rows.map(parseRecord);
  }

  latest(user: string, kind: AuditRecord["kind"]): AuditRecord | null {
    const row = this.db
      .prepare("SELECT json FROM audit WHERE user = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
      .get(user, kind) as JsonRow | undefined;
    return row === undefined ? null : parseRecord(row);
  }

  /** Allowed rescues with no outcome yet: after a crash, these get picked back up. */
  unfinishedRescues(): AuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT json FROM audit a
         WHERE a.kind = 'RESCUE_ALLOWED' AND NOT EXISTS (
           SELECT 1 FROM audit b
           WHERE b.request_id = a.request_id AND b.kind IN ('RESCUE_DONE', 'RESCUE_FAILED')
         )
         ORDER BY a.seq`,
      )
      .all() as JsonRow[];
    return rows.map(parseRecord);
  }

  stats(): StatsResponse {
    const totals = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(kind = 'RESCUE_DONE'), 0) AS rescues,
           COALESCE(SUM(CASE WHEN kind = 'RESCUE_DONE' THEN json_extract(json, '$.request.usdNeeded') END), 0) AS usd,
           COALESCE(SUM(kind = 'RESCUE_BLOCKED'), 0) AS blocked
         FROM audit`,
      )
      .get() as { rescues: number; usd: number; blocked: number };
    const latencies = this.db
      .prepare(
        `SELECT json_extract(json, '$.latencyMs') AS ms FROM audit
         WHERE kind = 'RESCUE_DONE' AND ms IS NOT NULL`,
      )
      .all() as { ms: number }[];
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
    this.db
      .prepare("INSERT INTO health (user, json) VALUES (?, ?) ON CONFLICT (user) DO UPDATE SET json = excluded.json")
      .run(user, JSON.stringify(response));
  }

  health(user: string): HealthResponse | null {
    const row = this.db.prepare("SELECT json FROM health WHERE user = ?").get(user) as JsonRow | undefined;
    return row === undefined ? null : (JSON.parse(row.json) as HealthResponse);
  }

  createTelegramCode(user: string, now: Date): { code: string; expiresAt: string } {
    const code = Array.from(
      { length: TELEGRAM_CODE_LENGTH },
      () => TELEGRAM_CODE_ALPHABET[randomInt(TELEGRAM_CODE_ALPHABET.length)],
    ).join("");
    const expiresAt = new Date(now.getTime() + TELEGRAM_CODE_TTL_MS).toISOString();
    this.db.prepare("INSERT INTO telegram_codes (code, user, expires_at) VALUES (?, ?, ?)").run(code, user, expiresAt);
    return { code, expiresAt };
  }

  close(): void {
    this.db.close();
  }
}
