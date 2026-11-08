import { initSync, js_get_collateral, js_verify, type SyncInitInput } from "@phala/dcap-qvl-web";
import type { IntelDcap } from "./attestation";

/**
 * The same Rust verifier as intel-node.ts, built for the web, which is what a
 * Cloudflare Worker can load: the Worker imports the .wasm file as a module and
 * passes it here. Node tests pass the file's bytes instead.
 */
export function webIntel(wasm: SyncInitInput): IntelDcap {
  let ready = false;
  const init = () => {
    if (!ready) {
      initSync({ module: wasm });
      ready = true;
    }
  };
  return {
    verify(rawQuote, collateral, nowSec) {
      init();
      return js_verify(rawQuote, collateral, nowSec);
    },
    getCollateral(pccsUrl, rawQuote) {
      init();
      return js_get_collateral(pccsUrl, rawQuote) as Promise<unknown>;
    },
  };
}
