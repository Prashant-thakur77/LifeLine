import { ASSETS, POLICY_DEFAULTS, POLICY_RANGES } from "@lifeline/shared";
import { hlAddressError, isNearAccount } from "./accounts";
import { formatUnits, parseUnits } from "./format";

/** The vault's set_policy argument. Amounts are USDC base units. */
export type VaultPolicyInput = {
  hl_address: string;
  keeper: string;
  warn: number;
  trigger: number;
  target: number;
  max_per_rescue: string;
  max_per_day: string;
  cooldown_sec: number;
};

/** What the vault's get_policy returns. */
export type VaultPolicyView = VaultPolicyInput & { paused: boolean };

/** The onboarding form, as typed. Caps are in USDC, not base units. */
export type PolicyDraft = {
  hlAddress: string;
  warn: string;
  trigger: string;
  target: string;
  maxPerRescueUsdc: string;
  maxPerDayUsdc: string;
  cooldownSec: string;
};

export type PolicyField = keyof PolicyDraft | "keeper";

export type PresetId = "careful" | "standard" | "tight";

export type Preset = { id: PresetId; label: string; blurb: string; warn: number; trigger: number; target: number };

/**
 * Three starting points, each inside the vault's ranges (warn 1.3–3.0, trigger 1.2–2.5
 * and below warn, target above trigger and at most 4.0). Standard is the plan's default.
 */
export const PRESETS: readonly Preset[] = [
  {
    id: "careful",
    label: "Careful",
    blurb: "Steps in early and refills generously. More reserve used, far from liquidation.",
    warn: 2.4,
    trigger: 2.0,
    target: 2.8,
  },
  {
    id: "standard",
    label: "Standard",
    blurb: "The default. Rescues at 1.5, back to 2.0, with a warning at 1.8.",
    warn: POLICY_DEFAULTS.warn,
    trigger: POLICY_DEFAULTS.trigger,
    target: POLICY_DEFAULTS.target,
  },
  {
    id: "tight",
    label: "Tight",
    blurb: "Waits until 1.3 and tops up just enough. Uses the least reserve, with less room.",
    warn: 1.5,
    trigger: 1.3,
    target: 1.6,
  },
];

/**
 * The vault takes any cap above 0, but 1Click won't route less than about 2 USDC to
 * Hyperliquid and the keeper never sends less, so a smaller cap would block every rescue.
 */
export const MIN_RESCUE_CAP_USDC = 2;

const USDC_DECIMALS = ASSETS.NEAR_USDC.decimals;
const MIN_RESCUE_CAP_BASE = BigInt(MIN_RESCUE_CAP_USDC) * 10n ** BigInt(USDC_DECIMALS);

const usdcFromBase = (base: string) => formatUnits(base, USDC_DECIMALS, USDC_DECIMALS).replace(/,/g, "").replace(/\.?0+$/, "");

export function presetDraft(id: PresetId, hlAddress = ""): PolicyDraft {
  const preset = PRESETS.find((p) => p.id === id) ?? PRESETS[1]!;
  return {
    hlAddress,
    warn: String(preset.warn),
    trigger: String(preset.trigger),
    target: String(preset.target),
    maxPerRescueUsdc: usdcFromBase(POLICY_DEFAULTS.maxPerRescue),
    maxPerDayUsdc: usdcFromBase(POLICY_DEFAULTS.maxPerDay),
    cooldownSec: String(POLICY_DEFAULTS.cooldownSec),
  };
}

/** Fills the form from a saved policy, so a returning user edits what they have. */
export function draftFromVault(view: VaultPolicyView): PolicyDraft {
  return {
    hlAddress: view.hl_address,
    warn: String(view.warn),
    trigger: String(view.trigger),
    target: String(view.target),
    maxPerRescueUsdc: usdcFromBase(view.max_per_rescue),
    maxPerDayUsdc: usdcFromBase(view.max_per_day),
    cooldownSec: String(view.cooldown_sec),
  };
}

/** Which preset these three levels are, or "custom". */
export function matchPreset(warn: number, trigger: number, target: number): PresetId | "custom" {
  return PRESETS.find((p) => p.warn === warn && p.trigger === trigger && p.target === target)?.id ?? "custom";
}

const DECIMAL = /^\d+(\.\d+)?$/;

function parseLevel(text: string): number | null {
  const trimmed = text.trim();
  return DECIMAL.test(trimmed) ? Number(trimmed) : null;
}

export type PolicyCheck =
  | { ok: true; policy: VaultPolicyInput }
  | { ok: false; errors: Partial<Record<PolicyField, string>> };

/**
 * The vault's set_policy checks, run before the wallet opens so a bad value never costs
 * a transaction. Same ranges, same strictness (trigger below warn, target above trigger),
 * plus the 2 USDC floor on the per-rescue cap explained above.
 */
export function validatePolicy(draft: PolicyDraft, keeper: string | null): PolicyCheck {
  const errors: Partial<Record<PolicyField, string>> = {};

  const hlError = hlAddressError(draft.hlAddress);
  if (hlError) errors.hlAddress = hlError;

  if (keeper === null || keeper === "") errors.keeper = "No keeper account is configured for this dashboard yet.";
  else if (!isNearAccount(keeper)) errors.keeper = `${keeper} isn't a valid NEAR account.`;

  const { warn: warnRange, trigger: triggerRange, target: targetRange, cooldownSec: cooldownRange } = POLICY_RANGES;

  const warn = parseLevel(draft.warn);
  if (warn === null) errors.warn = "Enter a number, like 1.8.";
  else if (warn < warnRange.min || warn > warnRange.max) errors.warn = `Warn must be from ${warnRange.min} to ${warnRange.max.toFixed(1)}.`;

  const trigger = parseLevel(draft.trigger);
  if (trigger === null) errors.trigger = "Enter a number, like 1.5.";
  else if (trigger < triggerRange.min || trigger > triggerRange.max) {
    errors.trigger = `Trigger must be from ${triggerRange.min} to ${triggerRange.max}.`;
  } else if (warn !== null && !(trigger < warn)) errors.trigger = "Trigger must be below warn.";

  const target = parseLevel(draft.target);
  if (target === null) errors.target = "Enter a number, like 2.0.";
  else if (target > targetRange.max) errors.target = `Target can be at most ${targetRange.max.toFixed(1)}.`;
  else if (trigger !== null && !(target > trigger)) errors.target = "Target must be above trigger.";

  const perRescue = parseUnits(draft.maxPerRescueUsdc, USDC_DECIMALS);
  if (!perRescue.ok) errors.maxPerRescueUsdc = perRescue.error;
  else if (BigInt(perRescue.base) < MIN_RESCUE_CAP_BASE) {
    errors.maxPerRescueUsdc = `At least ${MIN_RESCUE_CAP_USDC} USDC: 1Click won't send less to Hyperliquid.`;
  }

  const perDay = parseUnits(draft.maxPerDayUsdc, USDC_DECIMALS);
  if (!perDay.ok) errors.maxPerDayUsdc = perDay.error;
  else if (perRescue.ok && BigInt(perDay.base) < BigInt(perRescue.base)) {
    errors.maxPerDayUsdc = "The daily cap must be at least the cap per rescue.";
  }

  const cooldownText = draft.cooldownSec.trim();
  const cooldown = /^\d+$/.test(cooldownText) ? Number(cooldownText) : null;
  if (cooldown === null) errors.cooldownSec = "Enter whole seconds, like 120.";
  else if (cooldown < cooldownRange.min || cooldown > cooldownRange.max) {
    errors.cooldownSec = `Cooldown must be from ${cooldownRange.min} to ${cooldownRange.max.toLocaleString("en-US")} seconds.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    policy: {
      hl_address: draft.hlAddress.trim().toLowerCase(),
      keeper: keeper!,
      warn: warn!,
      trigger: trigger!,
      target: target!,
      max_per_rescue: (perRescue as { base: string }).base,
      max_per_day: (perDay as { base: string }).base,
      cooldown_sec: cooldown!,
    },
  };
}
