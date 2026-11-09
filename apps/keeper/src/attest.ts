import { checkAttestationWithSigners } from "./attestation";
import { DEFAULT_NEAR_AI_MODEL, DEFAULT_NEAR_AI_URL } from "./config";
import { createExplainer, templateExplanation } from "./explain";
import { describeAttestation } from "./format";
import { nodeIntel } from "./intel-node";

/**
 * One real check against NEAR AI, NVIDIA and Intel. With a NEAR AI key it then asks the
 * model for one explanation and checks that answer's signature against the attested key,
 * the same check every explanation passes before it reaches the log.
 * Exit 0 verified, 1 failed, 2 not available, 3 the answer's signature didn't verify.
 */
async function main() {
  try {
    process.loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch {
    // No .env file: the defaults work, because this model's report needs no key today.
  }
  const baseUrl = process.env.NEAR_AI_BASE_URL?.trim() || DEFAULT_NEAR_AI_URL;
  const model = process.env.NEAR_AI_MODEL?.trim() || DEFAULT_NEAR_AI_MODEL;
  const apiKey = process.env.NEAR_AI_API_KEY?.trim() || null;
  const { signers, ...result } = await checkAttestationWithSigners({ baseUrl, model, apiKey, now: () => new Date(), intel: nodeIntel });
  console.log(describeAttestation(result));
  if (result.status === "failed") process.exitCode = 1;
  if (result.status === "not available") process.exitCode = 2;
  if (result.status !== "verified") return;

  console.log(`\nAttested signing key${signers.length === 1 ? "" : "s"}: ${signers.join(", ")}`);
  if (apiKey === null) {
    console.log("Set NEAR_AI_API_KEY to also check one answer's signature against it.");
    return;
  }
  const notes: string[] = [];
  const explainer = createExplainer({ baseUrl, apiKey, model, signers: () => signers, log: (line) => notes.push(line) });
  const sample = {
    id: "attest-sample",
    user: "demo.near",
    at: new Date().toISOString(),
    kind: "RESCUE_BLOCKED" as const,
    healthBefore: 1.44,
    decision: { verdict: "block" as const, reasons: ["COOLDOWN"] },
  };
  const facts = templateExplanation(sample);
  const words = (await explainer.explain(sample)) ?? facts;
  // Kept only if the model's sentence made it past every check, signature included.
  const modelWords = words.startsWith(facts) ? words.slice(facts.length).trim() : "";
  if (modelWords !== "") {
    console.log(`One answer, signed in the enclave and verified against that key:\n  "${modelWords}"`);
  } else {
    console.log(`The model's answer wasn't kept${notes.length > 0 ? `: ${notes.join("; ")}` : " (it was empty, cut off or broke the explanation rules)"}.`);
    process.exitCode = 3;
  }
}

void main();
