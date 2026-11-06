// Fake data for building before the keeper is live. Every value is made up.
// Import from "@lifeline/shared/fixtures", or read the JSON files directly.

import type {
  AttestationResponse,
  AuditResponse,
  HealthResponse,
  StatsResponse,
  TelegramLinkResponse,
} from "../src/index";
import attestation from "./attestation.json";
import auditRecords from "./audit-records.json";
import healthBelowTrigger from "./health-below-trigger.json";
import healthNoPositions from "./health-no-positions.json";
import healthSafe from "./health-safe.json";
import healthUnknown from "./health-unknown.json";
import healthWarn from "./health-warn.json";
import stats from "./stats.json";
import telegramLink from "./telegram-link.json";

export const fixtures = {
  healthSafe: healthSafe as HealthResponse,
  healthWarn: healthWarn as HealthResponse,
  healthBelowTrigger: healthBelowTrigger as HealthResponse,
  healthNoPositions: healthNoPositions as HealthResponse,
  healthUnknown: healthUnknown as HealthResponse,
  auditRecords: auditRecords as AuditResponse,
  stats: stats as StatsResponse,
  telegramLink: telegramLink as TelegramLinkResponse,
  attestation: attestation as AttestationResponse,
};
