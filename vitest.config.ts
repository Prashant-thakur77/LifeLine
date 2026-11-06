import { defineConfig } from "vitest/config";

// Each folder here is its own project. spike/ is left out on purpose: it is
// kept as evidence and never imported. Contract tests run through cargo; see
// scripts/test-contracts.mjs.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "research/*", "scripts"],
  },
});
