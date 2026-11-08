import type { AttestationResponse } from "@lifeline/shared";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  AttestationMonitor,
  checkAttestation,
  checkGpuClaims,
  isWellFormedQuote,
  reportFields,
  verifyQuoteOffline,
  verifyQuoteWith,
  type AttestationOptions,
  type IntelDcap,
} from "../src/attestation";
import { NOT_AVAILABLE_ATTESTATION } from "../src/api";
import { nodeIntel } from "../src/intel-node";
import { webIntel } from "../src/intel-web";
import collateral from "./recorded/attestation-collateral.json";
import jwks from "./recorded/attestation-jwks.json";
import meta from "./recorded/attestation-meta.json";
import nras from "./recorded/attestation-nras.json";
import report from "./recorded/attestation-report.json";

const NONCE = meta.nonce;
const NOW = new Date(meta.recordedAtSec * 1000);

type Respond = (url: string, init?: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const honest: Respond = (url) => (url.includes("nras.") ? json(nras) : json(report));

/** The gateway runs on a different Intel platform, so its quote has its own collateral. */
const verifyRecorded = (quote: string) =>
  verifyQuoteOffline(quote, quote === report.gateway_attestation.intel_quote ? collateral.gateway : collateral.model, BigInt(meta.recordedAtSec), nodeIntel);

const run = (overrides: { respond?: Respond; options?: Partial<AttestationOptions> } = {}) =>
  checkAttestation({
    baseUrl: "https://near-ai.test/v1",
    model: meta.model as string,
    now: () => NOW,
    intel: nodeIntel,
    randomNonce: () => NONCE,
    fetch: (async (url: string, init?: RequestInit) => (overrides.respond ?? honest)(String(url), init)) as typeof fetch,
    verifyQuote: async (quote: string) => verifyRecorded(quote),
    jwks: createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]),
    ...overrides.options,
  });

const copy = () => structuredClone(report) as typeof report;
const attestation = (r: typeof report) => r.model_attestations[0]!;
const check = (result: Awaited<ReturnType<typeof run>>, name: string) => result.checks.find((c) => c.name === name);

const NONCE_CHECK = "fresh nonce echoed in the report";
const QUOTE_CHECK = "TEE quote is valid";
const GPU_CHECK = "GPU attestation is valid";
const BINDING_CHECK = "signing key is bound to the report";
const COMPOSE_CHECK = "running software matches the quote";
const GATEWAY_CHECK = "gateway is attested too";

describe("a real report, with the real cryptography", () => {
  it("verifies", async () => {
    const result = await run();
    expect(result.checks.map((c) => [c.name, c.passed])).toEqual([
      [NONCE_CHECK, true],
      [QUOTE_CHECK, true],
      [BINDING_CHECK, true],
      [GPU_CHECK, true],
      [COMPOSE_CHECK, true],
      [GATEWAY_CHECK, true],
    ]);
    expect(result.status).toBe("verified");
    expect(result.model).toBe(meta.model);
    expect(result.checkedAt).toBe(NOW.toISOString());
  });

  it("has the same shape as the fixture the dashboard builds on", async () => {
    expect(Object.keys(await run()).sort()).toEqual(["checkedAt", "checks", "model", "status"]);
  });

  it("asks for the report with its fresh nonce, the model, and the API key if there is one", async () => {
    const urls: string[] = [];
    let auth: string | null = null;
    await run({
      respond: (url, init) => {
        urls.push(url);
        if (url.includes("attestation/report")) auth = new Headers(init?.headers).get("authorization");
        return honest(url, init);
      },
      options: { apiKey: "secret-key" },
    });
    expect(urls[0]).toContain(`nonce=${NONCE}`);
    expect(urls[0]).toContain(`model=${encodeURIComponent(meta.model as string)}`);
    expect(urls[0]).toContain("signing_algo=ecdsa");
    expect(auth).toBe("Bearer secret-key");
  });

  it("never sends the API key to NVIDIA", async () => {
    let nvidiaAuth: string | null = "unset";
    await run({
      respond: (url, init) => {
        if (url.includes("nras.")) nvidiaAuth = new Headers(init?.headers).get("authorization");
        return honest(url, init);
      },
      options: { apiKey: "secret-key" },
    });
    expect(nvidiaAuth).toBeNull();
  });

  it("makes a new nonce for each check", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2; i += 1) {
      await checkAttestation({
        baseUrl: "https://near-ai.test/v1",
        model: "m",
        now: () => NOW,
        intel: nodeIntel,
        fetch: (async (url: string) => {
          seen.add(new URL(url).searchParams.get("nonce") ?? "");
          return json({}, 500);
        }) as typeof fetch,
        verifyQuote: async () => {
          throw new Error("unused");
        },
        jwks: createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]),
      });
    }
    expect(seen.size).toBe(2);
    for (const nonce of seen) expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a report that shouldn't be trusted", () => {
  it("fails if it was made for someone else's nonce, a replay", async () => {
    const result = await run({ options: { randomNonce: () => "ab".repeat(32) } });
    expect(result.status).toBe("failed");
    expect(check(result, NONCE_CHECK)?.passed).toBe(false);
    expect(check(result, BINDING_CHECK)?.passed).toBe(false);
    expect(check(result, GPU_CHECK)?.passed).toBe(false);
  });

  it("fails if the Intel quote was changed by one byte", async () => {
    const r = copy();
    const quote = attestation(r).intel_quote;
    attestation(r).intel_quote = `${quote.slice(0, 1200)}${quote[1200] === "0" ? "1" : "0"}${quote.slice(1201)}`;
    const result = await run({ respond: (url) => (url.includes("nras.") ? json(nras) : json(r)) });
    expect(result.status).toBe("failed");
    expect(check(result, QUOTE_CHECK)?.passed).toBe(false);
  });

  it("fails if the signing key isn't the one the hardware vouches for", async () => {
    const r = copy();
    attestation(r).signing_address = "0x9999999999999999999999999999999999999999";
    const result = await run({ respond: (url) => (url.includes("nras.") ? json(nras) : json(r)) });
    expect(result.status).toBe("failed");
    expect(check(result, BINDING_CHECK)?.passed).toBe(false);
  });

  it("fails if the running software isn't what the quote measured", async () => {
    const r = copy();
    attestation(r).info.tcb_info = JSON.stringify({ app_compose: '{"docker_compose_file":"evil"}' });
    const result = await run({ respond: (url) => (url.includes("nras.") ? json(nras) : json(r)) });
    expect(result.status).toBe("failed");
    expect(check(result, COMPOSE_CHECK)?.passed).toBe(false);
  });

  it("fails if NVIDIA's answer was forged, even with all the right claims", async () => {
    const forged = structuredClone(nras) as [[string, string], Record<string, string>];
    const [head, payload] = forged[0][1].split(".");
    forged[0][1] = `${head}.${payload}.${Buffer.from("forged").toString("base64url")}`;
    const result = await run({ respond: (url) => (url.includes("nras.") ? json(forged) : json(report)) });
    expect(result.status).toBe("failed");
    expect(check(result, GPU_CHECK)?.passed).toBe(false);
  });

  it("fails if the report is for a different model than the one that writes the explanations", async () => {
    const result = await run({ options: { model: "some/other-model" } });
    expect(result.status).toBe("failed");
    expect(check(result, BINDING_CHECK)?.detail).toMatch(/model/i);
  });

  it("fails if the answer is correctly signed, but by someone other than NVIDIA", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES384");
    const claims = {
      eat_nonce: NONCE,
      "x-nvidia-overall-att-result": true,
      secboot: true,
      dbgstat: "disabled",
      measres: "success",
      ueid: "1",
      "x-nvidia-gpu-attestation-report-signature-verified": true,
      "x-nvidia-gpu-attestation-report-nonce-match": true,
      "x-nvidia-gpu-attestation-report-cert-chain-validated": true,
      "x-nvidia-gpu-driver-rim-signature-verified": true,
      "x-nvidia-gpu-vbios-rim-signature-verified": true,
    };
    const sign = (issuer: string) =>
      new SignJWT(claims).setProtectedHeader({ alg: "ES384", kid: "other" }).setIssuer(issuer).sign(privateKey);
    const otherJwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "other", alg: "ES384" }] });
    const answer = async (issuer: string) => [["JWT", await sign(issuer)], { "GPU-0": await sign(issuer) }];

    const impostor = await answer("https://attacker.example");
    const rejected = await run({ respond: (url) => (url.includes("nras.") ? json(impostor) : json(report)), options: { jwks: otherJwks } });
    expect(check(rejected, GPU_CHECK)?.passed).toBe(false);

    // The same token from the right issuer passes, so it really is the issuer being refused.
    const genuine = await answer("https://nras.attestation.nvidia.com");
    const accepted = await run({ respond: (url) => (url.includes("nras.") ? json(genuine) : json(report)), options: { jwks: otherJwks } });
    expect(check(accepted, GPU_CHECK)?.passed).toBe(true);
  });

  it("fails if the gateway's quote was changed, even when the model's checks out", async () => {
    const r = copy();
    const quote = r.gateway_attestation.intel_quote;
    r.gateway_attestation.intel_quote = `${quote.slice(0, 1200)}${quote[1200] === "0" ? "1" : "0"}${quote.slice(1201)}`;
    const result = await run({
      respond: (url) => (url.includes("nras.") ? json(nras) : json(r)),
      options: { verifyQuote: async (q) => verifyQuoteOffline(q, q === r.gateway_attestation.intel_quote ? collateral.gateway : collateral.model, BigInt(meta.recordedAtSec), nodeIntel) },
    });
    expect(result.status).toBe("failed");
    expect(check(result, GATEWAY_CHECK)?.passed).toBe(false);
    expect(check(result, QUOTE_CHECK)?.passed).toBe(true);
  });

  it("fails if the gateway's report says it's for another nonce", async () => {
    const r = copy();
    r.gateway_attestation.request_nonce = "ab".repeat(32);
    const result = await run({ respond: (url) => (url.includes("nras.") ? json(nras) : json(r)) });
    expect(result.status).toBe("failed");
    expect(check(result, GATEWAY_CHECK)?.passed).toBe(false);
  });

  it("fails if the gateway's key isn't the one its quote vouches for", async () => {
    const r = copy();
    r.gateway_attestation.signing_address = "0x9999999999999999999999999999999999999999";
    const result = await run({ respond: (url) => (url.includes("nras.") ? json(nras) : json(r)) });
    expect(result.status).toBe("failed");
    expect(check(result, GATEWAY_CHECK)?.passed).toBe(false);
  });

  it("fails if the report has no gateway at all", async () => {
    const { gateway_attestation: _dropped, ...r } = copy();
    const result = await run({ respond: (url) => (url.includes("nras.") ? json(nras) : json(r)) });
    expect(result.status).toBe("failed");
    expect(check(result, GATEWAY_CHECK)?.passed).toBe(false);
  });

  it.each([
    ["garbage", "zz"],
    ["empty", ""],
    ["cut short", report.model_attestations[0]!.intel_quote.slice(0, 2000)],
  ])("fails on a %s quote, rather than blaming an outage", async (_name, quote) => {
    const r = copy();
    attestation(r).intel_quote = quote;
    const result = await run({
      respond: (url) => (url.includes("nras.") ? json(nras) : json(r)),
      options: {
        verifyQuote: verifyQuoteWith(async () => {
          throw new Error("this quote should never reach the network");
        }, () => NOW, nodeIntel),
      },
    });
    expect(result.status).toBe("failed");
    expect(check(result, QUOTE_CHECK)?.passed).toBe(false);
  });

  it("fails if NVIDIA itself refuses the evidence as bad", async () => {
    const result = await run({ respond: (url) => (url.includes("nras.") ? json({ message: "bad evidence" }, 400) : json(report)) });
    expect(result.status).toBe("failed");
    expect(check(result, GPU_CHECK)?.passed).toBe(false);
  });

  it("fails if the Intel status is revoked", async () => {
    const result = await run({
      options: {
        verifyQuote: async (quote) => ({ ...verifyRecorded(quote), status: "Revoked" }),
      },
    });
    expect(result.status).toBe("failed");
    expect(check(result, QUOTE_CHECK)?.detail).toContain("Revoked");
  });

  it("passes OutOfDate but says so, as the official verifier does", async () => {
    const result = await run({ options: { verifyQuote: async (quote) => ({ ...verifyRecorded(quote), status: "OutOfDate" }) } });
    expect(result.status).toBe("verified");
    expect(check(result, QUOTE_CHECK)?.detail).toContain("OutOfDate");
  });

  it("still says OutOfDate when several nodes are serving", async () => {
    const r = copy();
    r.model_attestations.push(structuredClone(attestation(r)));
    const result = await run({
      respond: (url) => (url.includes("nras.") ? json(nras) : json(r)),
      options: { verifyQuote: async (quote) => ({ ...verifyRecorded(quote), status: "OutOfDate" }) },
    });
    expect(result.status).toBe("verified");
    expect(check(result, QUOTE_CHECK)?.detail).toContain("OutOfDate");
  });

  it("tolerates a little clock skew, because that isn't fraud", async () => {
    const claims = JSON.parse(Buffer.from((nras as unknown as [[string, string]])[0][1].split(".")[1] ?? "", "base64url").toString()) as { iat: number };
    const result = await run({ options: { now: () => new Date((claims.iat - 2) * 1000) } });
    expect(check(result, GPU_CHECK)?.passed).toBe(true);
  });

  it("checks every node serving the model, not only the first", async () => {
    const r = copy();
    const bad = structuredClone(attestation(r));
    bad.signing_address = "0x9999999999999999999999999999999999999999";
    r.model_attestations.push(bad);
    const result = await run({ respond: (url) => (url.includes("nras.") ? json(nras) : json(r)) });
    expect(result.status).toBe("failed");
  });
});

describe("when a check can't run at all", () => {
  it.each([
    ["NEAR AI is down", ((url) => (url.includes("nras.") ? json(nras) : json({}, 503))) as Respond],
    ["NVIDIA is down", ((url) => (url.includes("nras.") ? json({}, 503) : json(report))) as Respond],
    ["the network fails", (() => Promise.reject(new Error("fetch failed"))) as Respond],
  ])("%s: says not available, because that isn't evidence of fraud", async (_name, respond) => {
    const result = await run({ respond });
    expect(result.status).toBe("not available");
  });

  it("says not available if Intel's collateral can't be fetched", async () => {
    const result = await run({
      options: {
        verifyQuote: verifyQuoteWith(async () => {
          throw new Error("error decoding response body");
        }, () => NOW, nodeIntel),
      },
    });
    expect(result.status).toBe("not available");
  });

  it("says not available when only NVIDIA's network fails", async () => {
    const result = await run({ respond: (url) => (url.includes("nras.") ? Promise.reject(new TypeError("fetch failed")) : json(report)) });
    expect(result.status).toBe("not available");
    expect(check(result, QUOTE_CHECK)?.passed).toBe(true);
  });

  it.each([
    ["a proxy's HTML in place of NVIDIA's answer", ((url) => (url.includes("nras.") ? new Response("<html>") : json(report))) as Respond],
    ["an NVIDIA answer of the wrong shape", ((url) => (url.includes("nras.") ? json({ odd: true }) : json(report))) as Respond],
    ["a proxy's HTML in place of the report", (() => new Response("<html>")) as Respond],
    ["an empty answer from NEAR AI", ((url) => (url.includes("nras.") ? json(nras) : json({}))) as Respond],
    ["no nodes serving right now", ((url) => (url.includes("nras.") ? json(nras) : json({ model_attestations: [] }))) as Respond],
  ])("says not available for %s", async (_name, respond) => {
    expect((await run({ respond })).status).toBe("not available");
  });

  it("says not available if NVIDIA's signing keys can't be fetched", async () => {
    const result = await run({
      options: {
        jwks: async () => {
          throw new Error("Expected 200 OK from the JSON Web Key Set HTTP response");
        },
      },
    });
    expect(result.status).toBe("not available");
  });

  it("verifies a real quote through the online path", async () => {
    const verify = verifyQuoteWith(async () => collateral.model, () => new Date(meta.recordedAtSec * 1000), nodeIntel);
    expect((await verify(attestation(report).intel_quote)).status).toBe("UpToDate");
  });

  it("won't say verified with more nodes than it can check, because the unchecked one could be the fraud", async () => {
    const r = copy();
    for (let i = 0; i < 20; i += 1) r.model_attestations.push(structuredClone(attestation(r)));
    const result = await run({ respond: (url) => (url.includes("nras.") ? json(nras) : json(r)) });
    expect(r.model_attestations).toHaveLength(21);
    expect(result.status).toBe("not available");
  });

  it("checks up to that limit", async () => {
    const r = copy();
    for (let i = 0; i < 2; i += 1) r.model_attestations.push(structuredClone(attestation(r)));
    const bad = r.model_attestations[2]!;
    bad.signing_address = "0x9999999999999999999999999999999999999999";
    const result = await run({ respond: (url) => (url.includes("nras.") ? json(nras) : json(r)) });
    expect(result.status).toBe("failed");
  });

  it("keeps secrets out of what it publishes", async () => {
    const result = await run({
      respond: () => Promise.reject(new Error("https://near-ai.test/?key=SECRET failed")),
      options: { apiKey: "SECRET" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});

describe("checkGpuClaims", () => {
  const nowSec = 1000;
  const overall = { "x-nvidia-overall-att-result": true, eat_nonce: "abc", exp: 2000 };
  const gpu = {
    eat_nonce: "abc",
    exp: 2000,
    secboot: true,
    dbgstat: "disabled",
    measres: "success",
    ueid: "1",
    "x-nvidia-gpu-attestation-report-signature-verified": true,
    "x-nvidia-gpu-attestation-report-nonce-match": true,
    "x-nvidia-gpu-attestation-report-cert-chain-validated": true,
    "x-nvidia-gpu-driver-rim-signature-verified": true,
    "x-nvidia-gpu-vbios-rim-signature-verified": true,
    "x-nvidia-gpu-driver-version": "570.133.20",
    "x-nvidia-attestation-warning": null,
  };

  it("passes good claims", () => {
    expect(checkGpuClaims(overall, { "GPU-0": gpu }, "ABC", nowSec)).toEqual({ passed: true, detail: "1 GPU" });
  });

  it.each([
    ["the overall result is false", { ...overall, "x-nvidia-overall-att-result": false }, gpu],
    ["the overall nonce differs", { ...overall, eat_nonce: "other" }, gpu],
    ["the overall token expired", { ...overall, exp: 999 }, gpu],
    ["a GPU's nonce differs", overall, { ...gpu, eat_nonce: "other" }],
    ["secure boot is off", overall, { ...gpu, secboot: false }],
    ["debug mode is on", overall, { ...gpu, dbgstat: "enabled" }],
    ["measurements failed", overall, { ...gpu, measres: "fail" }],
    ["a verified field is false", overall, { ...gpu, "x-nvidia-gpu-driver-rim-signature-verified": false }],
    ["a verified field is the string false", overall, { ...gpu, "x-nvidia-gpu-driver-rim-signature-verified": "false" }],
    ["any other flag isn't true", overall, { ...gpu, "x-nvidia-gpu-arch-check": false }],
    ["any other flag is the string false", overall, { ...gpu, "x-nvidia-gpu-arch-check": "false" }],
    ["there's a warning", overall, { ...gpu, "x-nvidia-attestation-warning": "careful" }],
    ["no equipment id", overall, { ...gpu, ueid: undefined }],
  ])("fails when %s", (_name, top, one) => {
    expect(checkGpuClaims(top, { "GPU-0": one }, "abc", nowSec).passed).toBe(false);
  });

  it("fails when a required flag is missing altogether", () => {
    const { "x-nvidia-gpu-attestation-report-signature-verified": _gone, ...without } = gpu;
    expect(checkGpuClaims(overall, { "GPU-0": without }, "abc", nowSec).passed).toBe(false);
  });

  it("fails with no GPUs at all", () => {
    expect(checkGpuClaims(overall, {}, "abc", nowSec).passed).toBe(false);
  });

  it("fails if one GPU of many is bad", () => {
    expect(checkGpuClaims(overall, { "GPU-0": gpu, "GPU-1": { ...gpu, secboot: false } }, "abc", nowSec).passed).toBe(false);
  });
});

describe("AttestationMonitor", () => {
  const verified: AttestationResponse = { status: "verified", checkedAt: "t", model: "m", checks: [] };

  it("says not available until the first check is done", () => {
    const monitor = new AttestationMonitor(async () => verified, { sleep: async () => {} });
    expect(monitor.latest().status).toBe("not available");
  });

  it("checks at once on startup, then every 6 hours, until stopped", async () => {
    const waits: number[] = [];
    let checks = 0;
    const monitor: AttestationMonitor = new AttestationMonitor(
      async () => {
        checks += 1;
        return verified;
      },
      {
        sleep: async (ms) => {
          waits.push(ms);
          if (waits.length === 2) monitor.stop();
        },
      },
    );
    await monitor.run();
    expect(checks).toBe(2);
    expect(waits).toEqual([6 * 3_600_000, 6 * 3_600_000]);
    expect(monitor.latest()).toEqual(verified);
  });

  it("doesn't keep saying verified after a later check throws", async () => {
    let calls = 0;
    const seen: string[] = [];
    const monitor: AttestationMonitor = new AttestationMonitor(
      async () => {
        calls += 1;
        if (calls === 2) throw new Error("boom");
        return verified;
      },
      {
        sleep: async () => {
          seen.push(monitor.latest().status);
          if (calls === 2) monitor.stop();
        },
      },
    );
    await monitor.run();
    expect(seen).toEqual(["verified", "not available"]);
  });

  it("rechecks in 10 minutes when it isn't verified, so an outage doesn't stick for 6 hours", async () => {
    const waits: number[] = [];
    const monitor: AttestationMonitor = new AttestationMonitor(
      async () => ({ status: "not available", checkedAt: null, model: null, checks: [] }),
      {
        sleep: async (ms) => {
          waits.push(ms);
          monitor.stop();
        },
      },
    );
    await monitor.run();
    expect(waits).toEqual([10 * 60_000]);
  });

  it("gives up on a check that hangs, and doesn't keep saying verified", async () => {
    let calls = 0;
    const seen: string[] = [];
    const monitor: AttestationMonitor = new AttestationMonitor(
      async () => {
        calls += 1;
        return calls === 1 ? verified : new Promise<AttestationResponse>(() => {});
      },
      {
        checkTimeoutMs: 20,
        sleep: async () => {
          seen.push(monitor.latest().status);
          if (calls === 2) monitor.stop();
        },
      },
    );
    await monitor.run();
    expect(seen).toEqual(["verified", "not available"]);
  });

  it("keeps going if a check throws, and reports not available", async () => {
    let calls = 0;
    const monitor: AttestationMonitor = new AttestationMonitor(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return verified;
      },
      {
        sleep: async () => {
          if (calls === 1) expect(monitor.latest().status).toBe("not available");
          if (calls === 2) monitor.stop();
        },
      },
    );
    await monitor.run();
    expect(monitor.latest()).toEqual(verified);
  });
});

describe("isWellFormedQuote", () => {
  const real = attestation(report).intel_quote;

  it("accepts real quotes", () => {
    expect(isWellFormedQuote(real)).toBe(true);
    expect(isWellFormedQuote(report.gateway_attestation.intel_quote)).toBe(true);
  });

  it.each([
    ["nothing", ""],
    ["not hex", "zz".repeat(800)],
    ["an odd length", `${real}0`],
    ["too short", real.slice(0, 100)],
    ["cut short", real.slice(0, 2000)],
    ["another version", `0900${real.slice(4)}`],
    ["another kind of enclave", `${real.slice(0, 8)}00000000${real.slice(16)}`],
  ])("refuses %s", (_name, quote) => {
    expect(isWellFormedQuote(quote)).toBe(false);
  });
});

describe("reportFields", () => {
  it("reads a TD10 report", () => {
    expect(reportFields({ TD10: { report_data: "a", mr_config_id: "b" } })).toEqual({ reportData: "a", mrConfig: "b" });
  });

  it("reads a TD15 report, which nests the same fields", () => {
    expect(reportFields({ TD15: { base: { report_data: "a", mr_config_id: "b" } } })).toEqual({ reportData: "a", mrConfig: "b" });
  });

  it("gives nothing for anything else, so the binding check fails", () => {
    expect(reportFields({})).toEqual({ reportData: "", mrConfig: "" });
  });
});

describe("the recorded fixture", () => {
  it("is what it claims: the compose hash really is in the quote", async () => {
    const tcb = JSON.parse(attestation(report).info.tcb_info) as { app_compose: string };
    const hash = createHash("sha256").update(tcb.app_compose).digest("hex");
    const quote = verifyRecorded(attestation(report).intel_quote);
    expect(quote.mrConfig.startsWith(`01${hash}`)).toBe(true);
  });
});

const require = createRequire(import.meta.url);
const ENGINES: [string, IntelDcap][] = [
  ["the Node build", nodeIntel],
  ["the web build Cloudflare runs", webIntel(readFileSync(require.resolve("@phala/dcap-qvl-web/dcap-qvl-web_bg.wasm")))],
];

describe.each(ENGINES)("Intel's quote verifier, %s", (_engine, intel) => {
  const quotes: [string, string, unknown][] = [
    ["model", attestation(report).intel_quote, collateral.model],
    ["gateway", report.gateway_attestation.intel_quote, collateral.gateway],
  ];

  it.each(quotes)("verifies the recorded %s quote, with the same report as the Node build", (_name, quote, quoteCollateral) => {
    const result = verifyQuoteOffline(quote, quoteCollateral, BigInt(meta.recordedAtSec), intel);
    expect(result.status).toBe("UpToDate");
    expect(result).toEqual(verifyQuoteOffline(quote, quoteCollateral, BigInt(meta.recordedAtSec), nodeIntel));
  });

  it("refuses a quote with one byte changed", () => {
    const quote = attestation(report).intel_quote;
    const at = quote.length - 200;
    const tampered = quote.slice(0, at) + (quote[at] === "0" ? "1" : "0") + quote.slice(at + 1);
    expect(() => verifyQuoteOffline(tampered, collateral.model, BigInt(meta.recordedAtSec), intel)).toThrow();
  });
});

describe("AttestationMonitor on a host that ticks, like a Durable Object", () => {
  const verified: AttestationResponse = { status: "verified", checkedAt: "t", model: "m", checks: [] };
  const HOUR = 3_600_000;

  const counting = (result: () => Promise<AttestationResponse>) => {
    let checks = 0;
    const monitor = new AttestationMonitor(
      () => {
        checks += 1;
        return result();
      },
      { sleep: async () => {} },
    );
    return { monitor, checks: () => checks };
  };

  it("checks on the first tick, and serves the result", async () => {
    const t = counting(async () => verified);
    await t.monitor.refreshIfDue(0);
    expect(t.checks()).toBe(1);
    expect(t.monitor.latest().status).toBe("verified");
  });

  it("doesn't start a second check while one is running", async () => {
    let finish: (value: AttestationResponse) => void = () => {};
    const t = counting(() => new Promise((resolve) => (finish = resolve)));
    const first = t.monitor.refreshIfDue(0);
    void t.monitor.refreshIfDue(5_000);
    expect(t.checks()).toBe(1);
    finish(verified);
    await first;
  });

  it("rechecks a verified result after 6 hours, not before", async () => {
    const t = counting(async () => verified);
    await t.monitor.refreshIfDue(0);
    await t.monitor.refreshIfDue(6 * HOUR - 1);
    expect(t.checks()).toBe(1);
    await t.monitor.refreshIfDue(6 * HOUR);
    expect(t.checks()).toBe(2);
  });

  it("rechecks after 10 minutes when the last check couldn't run, so an outage doesn't stick", async () => {
    const t = counting(async () => NOT_AVAILABLE_ATTESTATION);
    await t.monitor.refreshIfDue(0);
    await t.monitor.refreshIfDue(10 * 60_000 - 1);
    expect(t.checks()).toBe(1);
    await t.monitor.refreshIfDue(10 * 60_000);
    expect(t.checks()).toBe(2);
  });

  it("says not available when a check throws, and drops an old verified", async () => {
    let fail = false;
    const t = counting(async () => {
      if (fail) throw new Error("boom");
      return verified;
    });
    await t.monitor.refreshIfDue(0);
    fail = true;
    await t.monitor.refreshIfDue(6 * HOUR);
    expect(t.monitor.latest().status).toBe("not available");
  });
});
