import { js_get_collateral, js_verify } from "@phala/dcap-qvl-node";
import type { IntelDcap } from "./attestation";

/** Intel's DCAP quote verifier, built for Node. */
export const nodeIntel: IntelDcap = {
  verify: (rawQuote, collateral, nowSec) => js_verify(rawQuote, collateral, nowSec),
  getCollateral: (pccsUrl, rawQuote) => js_get_collateral(pccsUrl, rawQuote) as Promise<unknown>,
};
