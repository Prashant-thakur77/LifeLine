import { REASON_CODES } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import { factsFor as browserFacts } from "../../web/src/lib/facts";
import { factsFor } from "../src/explain";
import { record, rescueRequest } from "./helpers";

// The verify page rebuilds the facts the model was told, to check they belong to the
// record on the ledger. It can only do that if it builds them exactly as the keeper does.
describe("the browser's copy of factsFor", () => {
  it("matches the keeper's for every kind of record", () => {
    const records = [
      record({ id: "w", kind: "WARN", healthBefore: 1.7 }),
      record({ id: "a", kind: "RESCUE_ALLOWED", healthBefore: 1.44, request: rescueRequest({ amount: "3470000", usdNeeded: 3.1 }) }),
      record({ id: "d", kind: "RESCUE_DONE", healthBefore: 1.44, healthAfter: 2.01, latencyMs: 6_400, oneClickStatus: "SUCCESS", request: rescueRequest() }),
      record({ id: "f", kind: "RESCUE_FAILED", healthBefore: 1.3, oneClickStatus: "REFUNDED" }),
      record({ id: "b", kind: "RESCUE_BLOCKED", healthBefore: 1.45, decision: { verdict: "block", reasons: [] } }),
    ];
    for (const r of records) expect(browserFacts(r)).toEqual(factsFor(r));
  });

  it("words every reason code the same way, and an unknown one too", () => {
    for (const code of [...REASON_CODES, "SOMETHING_NEW"]) {
      const r = record({ id: code, kind: "RESCUE_BLOCKED", healthBefore: 1.45, decision: { verdict: "block", reasons: [code] } });
      expect(browserFacts(r)).toEqual(factsFor(r));
    }
  });
});
