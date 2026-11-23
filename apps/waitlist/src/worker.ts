import { DurableObject } from "cloudflare:workers";
import { createWaitlist } from "./waitlist";

type Env = { WAITLIST: DurableObjectNamespace<WaitlistObject>; ALLOWED_ORIGINS: string; WAITLIST_ADMIN_TOKEN?: string };

/** One object holds the whole list, in its own SQLite. */
export class WaitlistObject extends DurableObject<Env> {
  private readonly waitlist = createWaitlist({
    storage: this.ctx.storage,
    allowedOrigins: this.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()),
    adminToken: this.env.WAITLIST_ADMIN_TOKEN?.trim() || null,
  });

  override fetch(request: Request): Promise<Response> {
    return this.waitlist.handle(request);
  }
}

export default {
  fetch: (request, env) => env.WAITLIST.get(env.WAITLIST.idFromName("waitlist")).fetch(request),
} satisfies ExportedHandler<Env>;
