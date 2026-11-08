import type { NextConfig } from "next";

// A static export: every page is plain HTML and client-side JavaScript in out/, served as
// Cloudflare Workers static assets, so no request ever runs server code. Pages that need
// an account read it from the query string (?user=…) instead of a dynamic route.
const config: NextConfig = {
  output: "export",
  transpilePackages: ["@lifeline/shared", "@lifeline/hyperliquid"],
  images: { unoptimized: true },
  // `pnpm typecheck` runs tsc on this package with the repo's TypeScript, so the build
  // doesn't type-check a second time.
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
  // Stops `next dev` writing an AGENTS.md into this folder.
  agentRules: false,
};

export default config;
