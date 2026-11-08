import { defineConfig } from "vitest/config";

// The dashboard's tests cover its pure functions only: formatting, policy checks, gauge
// math, 1Click status messages, sim detection and URL builders. The root vitest config
// finds this file through its "apps/*" project glob.
export default defineConfig({
  test: {
    name: "web",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
