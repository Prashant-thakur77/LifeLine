import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REFUSED_RESCUE } from "../src/lib/proof";

describe("REFUSED_RESCUE", () => {
  it("is exactly the on-chain refusal that pnpm demo:attack re-checks, so the page can't drift from the evidence", () => {
    const saved = JSON.parse(readFileSync(new URL("../../../scripts/attack-proof-testnet.json", import.meta.url), "utf8")) as {
      network: string;
      txHash: string;
      signer: string;
      vault: string;
      failure: string;
      recordedAt: string;
    };
    const panic = JSON.parse(saved.failure).ActionError.kind.FunctionCallError.ExecutionError as string;
    expect(REFUSED_RESCUE).toEqual({
      network: saved.network,
      txHash: saved.txHash,
      signer: saved.signer,
      vault: saved.vault,
      method: "rescue",
      panic: panic.replace(/^Smart contract panicked: /, ""),
      at: saved.recordedAt,
    });
  });
});
