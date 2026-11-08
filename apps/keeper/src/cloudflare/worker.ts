import { KeeperObject, type Env } from "./keeper-object";

export { KeeperObject };

/** There is one keeper, so every request goes to the one object. */
const keeper = (env: Env) => env.KEEPER.get(env.KEEPER.idFromName("keeper"));

export default {
  fetch: (request, env) => keeper(env).fetch(request),
  // The alarm keeps itself going. This wakes the object after a deploy, and re-arms it if the loop ever stops.
  scheduled: async (_controller, env) => {
    await keeper(env).ensureRunning();
  },
} satisfies ExportedHandler<Env>;
