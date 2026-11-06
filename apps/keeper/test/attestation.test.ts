import type { AttestationResponse } from "@lifeline/shared";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AttestationMonitor,
  checkAttestation,
  checkGpuClaims,
  verifyQuoteOffline,
  type AttestationOptions,
} from "../src/attestation";
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

const run = (overrides: { respond?: Respond; options?: Partial<AttestationOptions> } = {}) =>
  checkAttestation({
    baseUrl: "https://near-ai.test/v1",
    model: meta.model as string,
    now: () => NOW,
    randomNonce: () => NONCE,
    fetch: (async (url: string, init?: RequestInit) => (overrides.respond ?? honest)(String(url), init)) as typeof fetch,
    verifyQuote: async (quote: string) => verifyQuoteOffline(quote, collateral, BigInt(meta.recordedAtSec)),
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

describe("a real report, with the real cryptography", () => {
  it("verifies", async () => {
    const result = await run();
    expect(result.checks.map((c) => [c.name, c.passed])).toEqual([
      [NONCE_CHECK, true],
      [QUOTE_CHECK, true],
      [BINDING_CHECK, true],
      [GPU_CHECK, true],
      [COMPOSE_CHECK, true],
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
    const claims = { eat_nonce: NONCE, "x-nvidia-overall-att-result": true, secboot: true, dbgstat: "disabled", measres: "success", ueid: "1" };
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

  it("fails if there's nothing to check", async () => {
    const result = await run({ respond: (url) => (url.includes("nras.") ? json(nras) : json({ model_attestations: [] })) });
    expect(result.status).toBe("failed");
  });

  it("fails if the Intel status is revoked", async () => {
    const result = await run({
      options: {
        verifyQuote: async (quote) => ({ ...(await verifyQuoteOffline(quote, collateral, BigInt(meta.recordedAtSec))), status: "Revoked" }),
      },
    });
    expect(result.status).toBe("failed");
    expect(check(result, QUOTE_CHECK)?.detail).toContain("Revoked");
  });

  it("passes OutOfDate but says so, as the official verifier does", async () => {
    const result = await run({
      options: {
        verifyQuote: async (quote) => ({ ...(await verifyQuoteOffline(quote, collateral, BigInt(meta.recordedAtSec))), status: "OutOfDate" }),
      },
    });
    expect(result.status).toBe("verified");
    expect(check(result, QUOTE_CHECK)?.detail).toContain("OutOfDate");
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
        verifyQuote: async () => {
          throw new TypeError("fetch failed");
        },
      },
    });
    expect(result.status).toBe("not available");
  });

  it("never throws", async () => {
    const result = await run({ respond: () => new Response("not json at all") });
    expect(["failed", "not available"]).toContain(result.status);
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
    "x-nvidia-gpu-driver-rim-signature-verified": true,
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
    ["there's a warning", overall, { ...gpu, "x-nvidia-attestation-warning": "careful" }],
    ["no equipment id", overall, { ...gpu, ueid: undefined }],
  ])("fails when %s", (_name, top, one) => {
    expect(checkGpuClaims(top, { "GPU-0": one }, "abc", nowSec).passed).toBe(false);
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

describe("the recorded fixture", () => {
  it("is what it claims: the compose hash really is in the quote", async () => {
    const tcb = JSON.parse(attestation(report).info.tcb_info) as { app_compose: string };
    const hash = createHash("sha256").update(tcb.app_compose).digest("hex");
    const quote = await verifyQuoteOffline(attestation(report).intel_quote, collateral, BigInt(meta.recordedAtSec));
    expect(quote.mrConfig.startsWith(`01${hash}`)).toBe(true);
  });
});
