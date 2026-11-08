import dcapWasm from "@phala/dcap-qvl-web/dcap-qvl-web_bg.wasm";
import { DurableObject } from "cloudflare:workers";
import { webIntel } from "../intel-web";
import { createKeeperHost, type KeeperHost } from "./host";

export type Env = { KEEPER: DurableObjectNamespace<KeeperObject> } & Record<string, unknown>;

/** Settings and secrets arrive as strings beside the bindings; only the strings are settings. */
const settingsOf = (env: Env) =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

/**
 * One object runs the whole keeper: the watch loop on its alarm, the audit log in its
 * own SQLite, the API and the Telegram webhook. Everything it does is in host.ts.
 */
export class KeeperObject extends DurableObject<Env> {
  private readonly host: KeeperHost;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.host = createKeeperHost({ storage: ctx.storage, env: settingsOf(env), intel: webIntel(dcapWasm) });
    void ctx.blockConcurrencyWhile(() => this.host.start());
  }

  override fetch(request: Request): Promise<Response> {
    return this.host.fetch(request);
  }

  override alarm(): Promise<void> {
    return this.host.alarm();
  }

  ensureRunning(): Promise<void> {
    return this.host.ensureRunning();
  }
}
