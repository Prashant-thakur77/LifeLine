import { checkAttestation } from "./attestation";
import { DEFAULT_NEAR_AI_MODEL, DEFAULT_NEAR_AI_URL } from "./config";
import { nodeIntel } from "./intel-node";
import { describeAttestation } from "./format";

/** One real check against NEAR AI, NVIDIA and Intel. Exit 0 verified, 1 failed, 2 not available. */
async function main() {
  try {
    process.loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch {
    // No .env file: the defaults work, because this model's report needs no key today.
  }
  const result = await checkAttestation({
    baseUrl: process.env.NEAR_AI_BASE_URL?.trim() || DEFAULT_NEAR_AI_URL,
    model: process.env.NEAR_AI_MODEL?.trim() || DEFAULT_NEAR_AI_MODEL,
    apiKey: process.env.NEAR_AI_API_KEY?.trim() || null,
    now: () => new Date(),
    intel: nodeIntel,
  });
  console.log(describeAttestation(result));
  if (result.status === "failed") process.exitCode = 1;
  if (result.status === "not available") process.exitCode = 2;
}

void main();
