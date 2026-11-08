import { serveWithEdgeCache } from "./edge-cache";
import { KeeperObject, type Env } from "./keeper-object";

export { KeeperObject };

/** There is one keeper, so every request goes to the one object. */
const keeper = (env: Env) => env.KEEPER.get(env.KEEPER.idFromName("keeper"));

export default {
  fetch: (request, env, ctx) =>
    serveWithEdgeCache(request, {
      cache: caches.default,
      upstream: () => keeper(env).fetch(request),
      waitUntil: (work) => ctx.waitUntil(work),
    }),
  // The alarm keeps itself going. This wakes the object after a deploy, re-arms an alarm
  // that's stuck, and retries a start that failed for a passing reason.
  scheduled: async (_controller, env) => {
    await keeper(env).ensureRunning();
  },
} satisfies ExportedHandler<Env>;
