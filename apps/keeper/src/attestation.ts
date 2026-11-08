import { createHash, randomBytes } from "node:crypto";
import type { AttestationResponse } from "@lifeline/shared";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { NOT_AVAILABLE_ATTESTATION } from "./api";

const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
const NRAS_ISSUER = "https://nras.attestation.nvidia.com";
const NRAS_JWKS_URL = "https://nras.attestation.nvidia.com/.well-known/jwks.json";
const INTEL_PCCS_URL = "https://api.trustedservices.intel.com/tdx/certification/v4";
const REQUEST_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 3 * 60_000;
const CLOCK_TOLERANCE_SEC = 60;
const VERIFIED_RECHECK_MS = 6 * 3_600_000;
const UNVERIFIED_RECHECK_MS = 10 * 60_000; // so an outage doesn't stick for 6 hours
const MAX_NODES = 20; // past this, some would go unchecked, so it can't honestly say verified

/** OutOfDate still has valid quote cryptography: the official NEAR AI verifier accepts it too. */
const GOOD_QUOTE_STATUSES = new Set(["UpToDate", "OutOfDate"]);

/** Only these mean the token itself is bad. Any other jose error is a problem reaching NVIDIA. */
const BAD_TOKEN_CODES = new Set([
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWS_INVALID",
  "ERR_JWT_INVALID",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JOSE_ALG_NOT_ALLOWED",
]);

const REQUIRED_GPU_FLAGS = [
  "x-nvidia-gpu-attestation-report-signature-verified",
  "x-nvidia-gpu-attestation-report-nonce-match",
  "x-nvidia-gpu-attestation-report-cert-chain-validated",
  "x-nvidia-gpu-driver-rim-signature-verified",
  "x-nvidia-gpu-vbios-rim-signature-verified",
];

const NONCE_CHECK = "fresh nonce echoed in the report";
const QUOTE_CHECK = "TEE quote is valid";
const BINDING_CHECK = "signing key is bound to the report";
const GPU_CHECK = "GPU attestation is valid";
const COMPOSE_CHECK = "running software matches the quote";
const GATEWAY_CHECK = "gateway is attested too";
const CHECK_ORDER = [NONCE_CHECK, QUOTE_CHECK, BINDING_CHECK, GPU_CHECK, COMPOSE_CHECK, GATEWAY_CHECK];

export type QuoteResult = { status: string; reportData: string; mrConfig: string };

/** Intel's DCAP verifier. intel-node.ts and intel-web.ts provide the same Rust code, built for Node and for Cloudflare. */
export type IntelDcap = {
  verify(rawQuote: Uint8Array, collateral: unknown, nowSec: bigint): unknown;
  getCollateral(pccsUrl: string, rawQuote: Uint8Array): Promise<unknown>;
};

export type AttestationOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  now: () => Date;
  intel: IntelDcap;
  randomNonce?: () => string;
  fetch?: typeof fetch;
  verifyQuote?: (quoteHex: string) => Promise<QuoteResult>;
  jwks?: JWTVerifyGetKey;
};

type Check = { name: string; passed: boolean; detail?: string };

/** A check that couldn't run. That isn't evidence of fraud, so it mustn't read as "failed". */
class Unavailable extends Error {}

type Enclave = { request_nonce?: unknown; signing_address?: unknown; intel_quote?: unknown; info?: { tcb_info?: unknown } };
type ModelNode = Enclave & { model_name?: unknown; nvidia_payload?: unknown };
type Report = { model_attestations?: unknown; gateway_attestation?: Enclave };

const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : "");
const hex = (value: unknown) => lower(value).replace(/^0x/, "");

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Unavailable("timed out")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Catches junk before any network call, or a garbage quote would look like an Intel outage. */
export function isWellFormedQuote(quoteHex: string): boolean {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(quoteHex)) return false;
  const bytes = Buffer.from(quoteHex, "hex");
  const signatureLengthAt = 632;
  if (bytes.length < signatureLengthAt + 4) return false;
  const version = bytes.readUInt16LE(0);
  if (bytes.readUInt32LE(4) !== 0x81) return false; // TDX
  if (version === 5) return true;
  if (version !== 4) return false;
  return bytes.length >= signatureLengthAt + 4 + bytes.readUInt32LE(signatureLengthAt);
}

type ReportFields = { report_data?: unknown; mr_config_id?: unknown };

/** TD15 reports nest the same fields under `base`. */
export function reportFields(report: { TD10?: ReportFields; TD15?: { base?: ReportFields } }): { reportData: string; mrConfig: string } {
  const fields = report.TD10 ?? report.TD15?.base;
  return { reportData: String(fields?.report_data ?? ""), mrConfig: String(fields?.mr_config_id ?? "") };
}

/** Real Intel DCAP verification. It throws on a bad quote. */
export function verifyQuoteOffline(quoteHex: string, collateral: unknown, nowSec: bigint, intel: IntelDcap): QuoteResult {
  const result = intel.verify(Buffer.from(quoteHex, "hex"), collateral, nowSec) as { status: string; report: Parameters<typeof reportFields>[0] };
  return { status: result.status, ...reportFields(result.report) };
}

export function verifyQuoteWith(getCollateral: (rawQuote: Buffer) => Promise<unknown>, now: () => Date, intel: IntelDcap) {
  return async (quoteHex: string): Promise<QuoteResult> => {
    if (!isWellFormedQuote(quoteHex)) throw new Error("malformed quote");
    let collateral: unknown;
    try {
      collateral = await getCollateral(Buffer.from(quoteHex, "hex"));
    } catch {
      throw new Unavailable("Intel's collateral couldn't be fetched");
    }
    return verifyQuoteOffline(quoteHex, collateral, BigInt(Math.floor(now().getTime() / 1000)), intel);
  };
}

/**
 * The claims NEAR AI's verification docs say to check. NVIDIA's overall result isn't
 * enough by itself: every GPU's own claims have to hold, with this request's nonce.
 */
export function checkGpuClaims(
  overall: JWTPayload | Record<string, unknown>,
  gpus: Record<string, JWTPayload | Record<string, unknown>>,
  nonce: string,
  nowSec: number,
): { passed: boolean; detail: string } {
  const fail = (detail: string) => ({ passed: false, detail });
  const expired = (claims: { exp?: unknown }) => typeof claims.exp === "number" && claims.exp <= nowSec;
  const top = overall as Record<string, unknown>;

  if (top["x-nvidia-overall-att-result"] !== true) return fail("NVIDIA's overall result isn't true");
  if (lower(top.eat_nonce) !== nonce.toLowerCase()) return fail("NVIDIA's answer is for another nonce");
  if (expired(top)) return fail("NVIDIA's answer has expired");

  const entries = Object.entries(gpus);
  if (entries.length === 0) return fail("NVIDIA's answer lists no GPUs");

  for (const [name, claims] of entries) {
    const gpu = claims as Record<string, unknown>;
    if (lower(gpu.eat_nonce) !== nonce.toLowerCase()) return fail(`${name} is for another nonce`);
    if (expired(gpu)) return fail(`${name}'s claims have expired`);
    if (gpu.secboot !== true) return fail(`${name} doesn't have secure boot on`);
    if (gpu.dbgstat !== "disabled") return fail(`${name} has debug mode on`);
    if (gpu.measres !== "success") return fail(`${name}'s measurements didn't pass`);
    if (gpu.ueid === undefined || gpu.ueid === null || gpu.ueid === "") return fail(`${name} has no equipment id`);
    if (gpu["x-nvidia-attestation-warning"] !== null && gpu["x-nvidia-attestation-warning"] !== undefined) {
      return fail(`${name} has an attestation warning`);
    }
    for (const flag of REQUIRED_GPU_FLAGS) {
      if (gpu[flag] !== true) return fail(`${name}: ${flag} isn't true`);
    }
    for (const [key, value] of Object.entries(gpu)) {
      const isFlag = key.startsWith("x-nvidia") && !key.endsWith("-version") && key !== "x-nvidia-ver" && key !== "x-nvidia-attestation-warning";
      if (isFlag && value !== true) return fail(`${name}: ${key} isn't true`);
    }
  }
  return { passed: true, detail: entries.length === 1 ? "1 GPU" : `${entries.length} GPUs` };
}

/**
 * Fetches a NEAR AI Cloud attestation with a fresh nonce and verifies it as the docs
 * describe: GPU through NVIDIA, CPU through Intel, the signing key and nonce bound in
 * the TDX report, the running software against the quote, and the same for the gateway.
 * Never throws. This only reports: nothing about a rescue depends on it, because the
 * model has no authority.
 */
export async function checkAttestation(options: AttestationOptions): Promise<AttestationResponse> {
  const { baseUrl, model, apiKey, now, intel } = options;
  const doFetch = options.fetch ?? fetch;
  const nonce = (options.randomNonce ?? (() => randomBytes(32).toString("hex")))().toLowerCase();
  const verifyQuote =
    options.verifyQuote ?? verifyQuoteWith((raw) => withTimeout(intel.getCollateral(INTEL_PCCS_URL, raw), REQUEST_TIMEOUT_MS), now, intel);
  const jwks = options.jwks ?? createRemoteJWKSet(new URL(NRAS_JWKS_URL), { timeoutDuration: REQUEST_TIMEOUT_MS });
  const answer = (status: AttestationResponse["status"], checks: Check[]): AttestationResponse => ({
    status,
    checkedAt: now().toISOString(),
    model,
    checks,
  });

  let report: Report | null;
  try {
    const url = `${baseUrl}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`;
    const response = await doFetch(url, {
      headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return answer("not available", []);
    report = (await response.json()) as Report | null;
  } catch {
    return answer("not available", []);
  }

  const nodes = report?.model_attestations;
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_NODES) return answer("not available", []);

  /** Null means Intel's verdict couldn't be had, which says nothing about the quote. */
  const verifyEnclaveQuote = async (enclave: Enclave): Promise<{ quote: QuoteResult | null; check: Check } | null> => {
    try {
      const quote = await verifyQuote(String(enclave.intel_quote ?? ""));
      const check = { name: QUOTE_CHECK, passed: GOOD_QUOTE_STATUSES.has(quote.status), detail: `Intel status: ${quote.status}` };
      return { quote, check };
    } catch (error) {
      if (error instanceof Unavailable) return null;
      return { quote: null, check: { name: QUOTE_CHECK, passed: false, detail: "Intel's verification rejected the quote" } };
    }
  };

  const isBound = (enclave: Enclave, quote: QuoteResult) => {
    const address = hex(enclave.signing_address);
    return address !== "" && hex(quote.reportData) === address.padEnd(64, "0") + nonce;
  };

  const softwareMatches = (enclave: Enclave, quote: QuoteResult) => {
    try {
      const raw = enclave.info?.tcb_info;
      const tcb = (typeof raw === "string" ? JSON.parse(raw) : raw) as { app_compose?: unknown };
      if (typeof tcb.app_compose !== "string") return false;
      return hex(quote.mrConfig).startsWith(`01${createHash("sha256").update(tcb.app_compose).digest("hex")}`);
    } catch {
      return false;
    }
  };

  /** Throws Unavailable if NVIDIA couldn't be asked. Only NVIDIA refusing the evidence, or a bad token, is a failure. */
  const checkGpu = async (node: ModelNode): Promise<Check> => {
    const failed = (detail: string): Check => ({ name: GPU_CHECK, passed: false, detail });
    let response: Response;
    try {
      response = await doFetch(NRAS_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: String(node.nvidia_payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Unavailable("NVIDIA couldn't be reached");
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      return failed("NVIDIA refused the GPU evidence");
    }
    if (!response.ok) throw new Unavailable("NVIDIA answered with an error");

    let overallToken: unknown;
    let gpuTokens: unknown;
    try {
      [[, overallToken], gpuTokens] = (await response.json()) as [[string, unknown], unknown];
    } catch {
      throw new Unavailable("NVIDIA's answer couldn't be read");
    }
    if (typeof overallToken !== "string" || gpuTokens === null || typeof gpuTokens !== "object") {
      throw new Unavailable("NVIDIA's answer isn't in the documented shape");
    }

    try {
      // Each token's signature proves NVIDIA said it. The claims alone could be forged.
      const verify = (token: string) =>
        jwtVerify(token, jwks, { issuer: NRAS_ISSUER, currentDate: now(), clockTolerance: CLOCK_TOLERANCE_SEC });
      await verify(overallToken);
      const gpus: Record<string, JWTPayload> = {};
      for (const [name, token] of Object.entries(gpuTokens)) gpus[name] = (await verify(String(token))).payload;
      const nowSec = Math.floor(now().getTime() / 1000) - CLOCK_TOLERANCE_SEC;
      return { name: GPU_CHECK, ...checkGpuClaims(decodeJwt(overallToken), gpus, nonce, nowSec) };
    } catch (error) {
      if (BAD_TOKEN_CODES.has((error as { code?: string } | null)?.code ?? "")) return failed("NVIDIA's answer failed its signature checks");
      throw new Unavailable("NVIDIA's signing keys couldn't be fetched");
    }
  };

  const checkNode = async (node: ModelNode): Promise<{ checks: Check[]; unavailable: boolean }> => {
    const checks: Check[] = [];
    let unavailable = false;

    let payloadNonce: unknown;
    try {
      payloadNonce = (JSON.parse(String(node.nvidia_payload)) as { nonce?: unknown }).nonce;
    } catch {
      payloadNonce = undefined;
    }
    const nonceEchoed = lower(node.request_nonce) === nonce && lower(payloadNonce) === nonce;
    checks.push({ name: NONCE_CHECK, passed: nonceEchoed, ...(nonceEchoed ? {} : { detail: "the report is for another nonce" }) });

    const verdict = await verifyEnclaveQuote(node);
    if (verdict === null) unavailable = true;
    else checks.push(verdict.check);

    if (lower(node.model_name) !== model.toLowerCase()) {
      checks.push({ name: BINDING_CHECK, passed: false, detail: "the report is for a different model" });
    } else if (verdict?.quote) {
      const bound = isBound(node, verdict.quote);
      checks.push({ name: BINDING_CHECK, passed: bound, ...(bound ? {} : { detail: "the quote doesn't vouch for this key and nonce" }) });
    } else if (verdict !== null) {
      checks.push({ name: BINDING_CHECK, passed: false, detail: "no verified quote to read it from" });
    }

    try {
      checks.push(await checkGpu(node));
    } catch {
      unavailable = true;
    }

    if (verdict?.quote) {
      const matches = softwareMatches(node, verdict.quote);
      checks.push({ name: COMPOSE_CHECK, passed: matches, ...(matches ? {} : { detail: "the software manifest doesn't match the quote" }) });
    } else if (verdict !== null) {
      checks.push({ name: COMPOSE_CHECK, passed: false, detail: "no verified quote to compare it with" });
    }
    return { checks, unavailable };
  };

  /** The gateway handles every request first, and the official verifier checks it too. */
  const checkGateway = async (gateway: Enclave | undefined): Promise<{ checks: Check[]; unavailable: boolean }> => {
    const result = (passed: boolean, detail: string) => ({ checks: [{ name: GATEWAY_CHECK, passed, detail }], unavailable: false });
    if (gateway === undefined || gateway === null) return result(false, "the report has no gateway attestation");
    const verdict = await verifyEnclaveQuote(gateway);
    if (verdict === null) return { checks: [], unavailable: true };
    if (lower(gateway.request_nonce) !== nonce) return result(false, "the gateway's report is for another nonce");
    if (verdict.quote === null || !verdict.check.passed) return result(false, verdict.check.detail ?? "the gateway's quote is invalid");
    if (!isBound(gateway, verdict.quote)) return result(false, "the gateway's quote doesn't vouch for its key and nonce");
    if (!softwareMatches(gateway, verdict.quote)) return result(false, "the gateway's software manifest doesn't match its quote");
    return result(true, verdict.check.detail ?? "");
  };

  try {
    const results: { checks: Check[]; unavailable: boolean }[] = [];
    for (const node of nodes as ModelNode[]) results.push(await checkNode(node));
    results.push(await checkGateway(report?.gateway_attestation));

    // One line per check, which holds only if it held everywhere it was run.
    const merged = CHECK_ORDER.flatMap((name): Check[] => {
      const found = results.flatMap((result) => result.checks.filter((check) => check.name === name));
      if (found.length === 0) return [];
      const failed = found.find((check) => !check.passed);
      const details = [...new Set(found.map((check) => check.detail).filter(Boolean))];
      const detail = failed?.detail ?? details.join("; ");
      return [{ name, passed: failed === undefined, ...(detail ? { detail } : {}) }];
    });

    if (merged.some((check) => !check.passed)) return answer("failed", merged);
    if (results.some((result) => result.unavailable)) return answer("not available", merged);
    return answer("verified", merged);
  } catch {
    return answer("not available", []);
  }
}

/** Checks on startup and every 6 hours, sooner if unverified, and always has an answer for the API. */
export type SavedAttestation = { result: AttestationResponse; nextCheckAt: number };

export class AttestationMonitor {
  private current: AttestationResponse = NOT_AVAILABLE_ATTESTATION;
  private stopped = false;

  constructor(
    private readonly check: () => Promise<AttestationResponse>,
    private readonly options: {
      sleep: (ms: number) => Promise<void>;
      checkTimeoutMs?: number;
      /** Called after each check, with when the next is due, so a host can keep both across a restart. */
      onChecked?: (state: SavedAttestation) => void;
    },
  ) {}

  /** Picks up a saved check, so a restart serves it at once and doesn't check again early. */
  restore(saved: SavedAttestation): void {
    this.current = saved.result;
    this.nextCheckAt = saved.nextCheckAt;
  }

  latest(): AttestationResponse {
    return this.current;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        this.current = await withTimeout(this.check(), this.options.checkTimeoutMs ?? CHECK_TIMEOUT_MS);
      } catch {
        this.current = NOT_AVAILABLE_ATTESTATION;
      }
      await this.options.sleep(this.current.status === "verified" ? VERIFIED_RECHECK_MS : UNVERIFIED_RECHECK_MS);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private checking = false;
  private nextCheckAt = 0;

  /**
   * For a host that ticks, like a Durable Object, instead of run()'s own loop: starts a
   * check when one is due, and resolves when that check is done. Same schedule as run().
   */
  async refreshIfDue(nowMs: number): Promise<void> {
    if (this.checking || nowMs < this.nextCheckAt) return;
    this.checking = true;
    try {
      this.current = await withTimeout(this.check(), this.options.checkTimeoutMs ?? CHECK_TIMEOUT_MS);
    } catch {
      this.current = NOT_AVAILABLE_ATTESTATION;
    } finally {
      this.checking = false;
    }
    this.nextCheckAt = nowMs + (this.current.status === "verified" ? VERIFIED_RECHECK_MS : UNVERIFIED_RECHECK_MS);
    this.options.onChecked?.({ result: this.current, nextCheckAt: this.nextCheckAt });
  }
}
