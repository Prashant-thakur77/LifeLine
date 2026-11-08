import type { AuditRecord } from "@lifeline/shared";
import { formatHealth, formatLatency } from "./format";
import { isSimulatedRecord, requestAmount } from "./records";

export type StoryPoint = { health: number; at: string };

/** The last finished rescue, told from the audit log alone: what the landing page replays. */
export type RescueStory = {
  /** The warning that came shortly before the trigger, if there was one. */
  warn: StoryPoint | null;
  trigger: StoryPoint;
  restored: StoryPoint;
  amount: string;
  latencyMs: number | null;
  simulated: boolean;
  explanation: string | null;
  /** How many policy rules the rescue broke (0 when allowed), or null when the record doesn't say. */
  rulesBroken: number | null;
  /** The Hyperliquid address the rescue paid. */
  recipient: string;
};

/** A warning further back than this belongs to an earlier dip, not this rescue's story. */
const WARN_WINDOW_MS = 10 * 60_000;

const finite = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n);
const time = (record: AuditRecord) => Date.parse(record.at);

/**
 * Finds the newest RESCUE_DONE that recorded health before and after, pairs it with its
 * RESCUE_ALLOWED (the moment the trigger was crossed) and the WARN just before that.
 * Every number comes from the records; nothing is interpolated or invented.
 */
export function lastRescueStory(records: readonly AuditRecord[]): RescueStory | null {
  const done = records
    .filter((r) => r.kind === "RESCUE_DONE" && r.request && finite(r.healthBefore) && finite(r.healthAfter))
    .sort((a, b) => time(b) - time(a))[0];
  if (!done?.request || !finite(done.healthBefore) || !finite(done.healthAfter)) return null;

  const allowed = records.find((r) => r.kind === "RESCUE_ALLOWED" && r.request?.id === done.request!.id);
  const trigger: StoryPoint = { health: done.healthBefore, at: allowed?.at ?? done.request.snapshot.at };
  const triggerMs = Date.parse(trigger.at);

  const warnRecord = records
    .filter((r) => {
      if (r.kind !== "WARN" || !finite(r.healthBefore) || r.healthBefore < trigger.health) return false;
      const before = triggerMs - time(r);
      return before >= 0 && before <= WARN_WINDOW_MS;
    })
    .sort((a, b) => time(b) - time(a))[0];

  return {
    warn: warnRecord && finite(warnRecord.healthBefore) ? { health: warnRecord.healthBefore, at: warnRecord.at } : null,
    trigger,
    restored: { health: done.healthAfter, at: done.at },
    amount: requestAmount(done.request),
    latencyMs: finite(done.latencyMs) ? done.latencyMs : null,
    simulated: isSimulatedRecord(done),
    explanation: done.explanation ?? null,
    rulesBroken: (allowed?.decision ?? done.decision)?.reasons.length ?? null,
    recipient: done.request.recipient,
  };
}

export type LogLine = { beat: "warn" | "trigger" | "throw" | "restored"; tag: "READ" | "QUOTE" | "POLICY" | "VAULT" | "SAFE"; text: string };

/**
 * The keeper's log of one rescue, for the landing page to step through as the replay
 * plays. Each line is a recorded fact; a fact the records don't hold is left out.
 */
export function storyLog(story: RescueStory, levels: { warn: number; trigger: number }): LogLine[] {
  const lines: LogLine[] = [];
  if (story.warn) lines.push({ beat: "warn", tag: "READ", text: `health ${formatHealth(story.warn.health)}, below the warn line of ${formatHealth(levels.warn)}` });
  lines.push({ beat: "trigger", tag: "READ", text: `health ${formatHealth(story.trigger.health)}, below the trigger of ${formatHealth(levels.trigger)}` });
  lines.push({ beat: "trigger", tag: "QUOTE", text: `${story.amount} to the perps balance` });
  lines.push({ beat: "trigger", tag: "POLICY", text: story.rulesBroken === 0 ? "allowed, no rule broken" : "allowed" });
  lines.push({ beat: "throw", tag: "VAULT", text: story.simulated ? "paid (simulated vault)" : "checked the signed quote and paid" });
  lines.push({
    beat: "restored",
    tag: "SAFE",
    text: `health ${formatHealth(story.restored.health)}${story.latencyMs !== null ? `, ${formatLatency(story.latencyMs)} after the trigger` : ""}`,
  });
  return lines;
}
