// Copies Intel's quote verifier (dcap-qvl, WebAssembly) into public/vendor/, so the
// verify page can load it from this site when someone asks for that check. Runs before
// `next dev` and `next build`; the copy isn't committed.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const source = require.resolve("@phala/dcap-qvl-web/dcap-qvl-web_bg.wasm");
const target = new URL("./public/vendor/dcap-qvl-web_bg.wasm", import.meta.url);
mkdirSync(new URL("./public/vendor/", import.meta.url), { recursive: true });
copyFileSync(source, target);
