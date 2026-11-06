import { createHash, randomBytes } from "node:crypto";
import { js_get_collateral, js_verify } from "@phala/dcap-qvl-node";
import type { AttestationResponse } from "@lifeline/shared";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { NOT_AVAILABLE_ATTESTATION } from "./api";

const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
const NRAS_ISSUER = "https://nras.attestation.nvidia.com";
const NRAS_JWKS_URL = "https://nras.attestation.nvidia.com/.well-known/jwks.json";
const INTEL_PCCS_URL = "https://api.trustedservices.intel.com/tdx/certification/v4";
const REQUEST_TIMEOUT_MS = 30_000;
const SIX_HOURS_MS = 6 * 3_600_000;
const MAX_NODES = 5; // every node costs a call to NVIDIA and to Intel

/** OutOfDate still has valid quote cryptography: the official NEAR AI verifier accepts it too. */
const GOOD_QUOTE_STATUSES = new Set(["UpToDate", "OutOfDate"]);

const NONCE_CHECK = "fresh nonce echoed in the report";
const QUOTE_CHECK = "TEE quote is valid";
const BINDING_CHECK = "signing key is bound to the report";
const GPU_CHECK = "GPU attestation is valid";
const COMPOSE_CHECK = "running software matches the quote";
const CHECK_ORDER = [NONCE_CHECK, QUOTE_CHECK, BINDING_CHECK, GPU_CHECK, COMPOSE_CHECK];

export type QuoteResult = { status: string; reportData: string; mrConfig: string };

export type AttestationOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  now: () => Date;
  randomNonce?: () => string;
  fetch?: typeof fetch;
  verifyQuote?: (quoteHex: string) => Promise<QuoteResult>;
  jwks?: JWTVerifyGetKey;
};

type Check = { name: string; passed: boolean; detail?: string };
/** A check that couldn't run. That isn't evidence of fraud, so it mustn't read as "failed". */
class Unavailable extends Error {}

type ReportNode = {
  model_name?: unknown;
  request_nonce?: unknown;
  signing_address?: unknown;
  intel_quote?: unknown;
  nvidia_payload?: unknown;
  info?: { tcb_info?: unknown };
};

const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : "");
const isNetworkFailure = (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || error.name === "JWKSTimeout"));

/** Real Intel DCAP verification. It throws on a bad quote. */
export function verifyQuoteOffline(quoteHex: string, collateral: unknown, nowSec: bigint): QuoteResult {
  const result = js_verify(Buffer.from(quoteHex, "hex"), collateral, nowSec) as {
    status: string;
    report: { TD10?: { report_data: string; mr_config_id: string }; TD15?: { report_data: string; mr_config_id: string } };
  };
  const td = result.report.TD10 ?? result.report.TD15;
  return { status: result.status, reportData: td?.report_data ?? "", mrConfig: td?.mr_config_id ?? "" };
}

async function verifyQuoteOnline(quoteHex: string, now: Date): Promise<QuoteResult> {
  let collateral: unknown;
  try {
    collateral = await js_get_collateral(INTEL_PCCS_URL, Buffer.from(quoteHex, "hex"));
  } catch {
    throw new Unavailable("Intel's collateral couldn't be fetched");
  }
  return verifyQuoteOffline(quoteHex, collateral, BigInt(Math.floor(now.getTime() / 1000)));
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

  if (overall["x-nvidia-overall-att-result" as keyof typeof overall] !== true) return fail("NVIDIA's overall result isn't true");
  if (lower(overall.eat_nonce) !== nonce.toLowerCase()) return fail("NVIDIA's answer is for another nonce");
  if (expired(overall)) return fail("NVIDIA's answer has expired");

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
    for (const [key, value] of Object.entries(gpu)) {
      if (key.startsWith("x-nvidia") && value === false) return fail(`${name}: ${key} is false`);
    }
  }
  return { passed: true, detail: entries.length === 1 ? "1 GPU" : `${entries.length} GPUs` };
}

/**
 * Fetches a NEAR AI Cloud attestation with a fresh nonce and verifies it as the docs
 * describe: GPU through NVIDIA, CPU through Intel, the signing key and nonce bound in
 * the TDX report, and the running software against the quote. Never throws. This only
 * reports: nothing about a rescue depends on it, because the model has no authority.
 */
export async function checkAttestation(options: AttestationOptions): Promise<AttestationResponse> {
  const { baseUrl, model, apiKey, now } = options;
  const doFetch = options.fetch ?? fetch;
  const nonce = (options.randomNonce ?? (() => randomBytes(32).toString("hex")))();
  const verifyQuote = options.verifyQuote ?? ((quote: string) => verifyQuoteOnline(quote, now()));
  const jwks = options.jwks ?? createRemoteJWKSet(new URL(NRAS_JWKS_URL), { timeoutDuration: REQUEST_TIMEOUT_MS });
  const answer = (status: AttestationResponse["status"], checks: Check[]): AttestationResponse => ({
    status,
    checkedAt: now().toISOString(),
    model,
    checks,
  });

  let nodes: unknown;
  try {
    const url = `${baseUrl}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`;
    const response = await doFetch(url, {
      headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return answer("not available", []);
    nodes = ((await response.json()) as { model_attestations?: unknown } | null)?.model_attestations;
  } catch {
    return answer("not available", []);
  }

  if (!Array.isArray(nodes) || nodes.length === 0) {
    return answer("failed", [{ name: NONCE_CHECK, passed: false, detail: "the report has no attestations to check" }]);
  }

  const checkGpu = async (node: ReportNode): Promise<Check> => {
    try {
      const response = await doFetch(NRAS_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: String(node.nvidia_payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Unavailable("NVIDIA's service answered with an error");
      const [[, overallToken], gpuTokens] = (await response.json()) as [[string, string], Record<string, string>];
      // Each token's signature proves NVIDIA said it. The claims alone could be forged.
      const verify = (token: string) => jwtVerify(token, jwks, { issuer: NRAS_ISSUER, currentDate: now() });
      await verify(overallToken);
      const gpus: Record<string, JWTPayload> = {};
      for (const [name, token] of Object.entries(gpuTokens)) gpus[name] = (await verify(token)).payload;
      const nowSec = Math.floor(now().getTime() / 1000);
      return { name: GPU_CHECK, ...checkGpuClaims(decodeJwt(overallToken), gpus, nonce, nowSec) };
    } catch (error) {
      if (error instanceof Unavailable || isNetworkFailure(error)) throw new Unavailable(GPU_CHECK);
      return { name: GPU_CHECK, passed: false, detail: "NVIDIA's answer failed signature or format checks" };
    }
  };

  const checkNode = async (node: ReportNode): Promise<{ checks: Check[]; unavailable: boolean }> => {
    const checks: Check[] = [];
    let unavailable = false;

    let payloadNonce: unknown;
    try {
      payloadNonce = (JSON.parse(String(node.nvidia_payload)) as { nonce?: unknown }).nonce;
    } catch {
      payloadNonce = undefined;
    }
    const nonceEchoed = lower(node.request_nonce) === nonce.toLowerCase() && lower(payloadNonce) === nonce.toLowerCase();
    checks.push({ name: NONCE_CHECK, passed: nonceEchoed, ...(nonceEchoed ? {} : { detail: "the report is for another nonce" }) });

    let quote: QuoteResult | null = null;
    try {
      quote = await verifyQuote(String(node.intel_quote));
      const passed = GOOD_QUOTE_STATUSES.has(quote.status);
      checks.push({ name: QUOTE_CHECK, passed, detail: `Intel status: ${quote.status}` });
    } catch (error) {
      if (error instanceof Unavailable || isNetworkFailure(error)) unavailable = true;
      else checks.push({ name: QUOTE_CHECK, passed: false, detail: "Intel's verification rejected the quote" });
    }

    if (lower(node.model_name) !== model.toLowerCase()) {
      checks.push({ name: BINDING_CHECK, passed: false, detail: "the report is for a different model" });
    } else if (quote !== null) {
      const address = lower(node.signing_address).replace(/^0x/, "");
      const expected = address.padEnd(64, "0") + nonce.toLowerCase();
      const bound = address !== "" && lower(quote.reportData).replace(/^0x/, "") === expected;
      checks.push({ name: BINDING_CHECK, passed: bound, ...(bound ? {} : { detail: "the quote doesn't vouch for this key and nonce" }) });
    } else if (!unavailable) {
      checks.push({ name: BINDING_CHECK, passed: false, detail: "no verified quote to read it from" });
    }

    try {
      checks.push(await checkGpu(node));
    } catch {
      unavailable = true;
    }

    if (quote !== null) {
      let hash = "";
      try {
        const raw = node.info?.tcb_info;
        const tcb = (typeof raw === "string" ? JSON.parse(raw) : raw) as { app_compose?: unknown };
        if (typeof tcb.app_compose === "string") hash = createHash("sha256").update(tcb.app_compose).digest("hex");
      } catch {
        hash = "";
      }
      const matches = hash !== "" && lower(quote.mrConfig).replace(/^0x/, "").startsWith(`01${hash}`);
      checks.push({ name: COMPOSE_CHECK, passed: matches, ...(matches ? {} : { detail: "the software manifest doesn't match the quote" }) });
    } else if (!unavailable) {
      checks.push({ name: COMPOSE_CHECK, passed: false, detail: "no verified quote to compare it with" });
    }
    return { checks, unavailable };
  };

  try {
    const picked = (nodes as ReportNode[]).slice(0, MAX_NODES);
    const results: { checks: Check[]; unavailable: boolean }[] = [];
    for (const node of picked) results.push(await checkNode(node));

    // One line per check, which holds only if it held on every node.
    const merged = CHECK_ORDER.flatMap((name): Check[] => {
      const found = results.flatMap((result) => result.checks.filter((check) => check.name === name));
      if (found.length === 0) return [];
      const failed = found.find((check) => !check.passed);
      const detail = failed?.detail ?? (picked.length > 1 ? `${picked.length} of ${nodes.length as number} nodes` : found[0]?.detail);
      return [{ name, passed: failed === undefined, ...(detail ? { detail } : {}) }];
    });

    if (merged.some((check) => !check.passed)) return answer("failed", merged);
    if (results.some((result) => result.unavailable)) return answer("not available", merged);
    return answer("verified", merged);
  } catch {
    return answer("not available", []);
  }
}

/** Checks on startup and every 6 hours, and always has an answer for the API. */
export class AttestationMonitor {
  private current: AttestationResponse = NOT_AVAILABLE_ATTESTATION;
  private stopped = false;

  constructor(
    private readonly check: () => Promise<AttestationResponse>,
    private readonly options: { sleep: (ms: number) => Promise<void> },
  ) {}

  latest(): AttestationResponse {
    return this.current;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        this.current = await this.check();
      } catch {
        this.current = NOT_AVAILABLE_ATTESTATION;
      }
      await this.options.sleep(SIX_HOURS_MS);
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
