// Lets tsc accept `import "./globals.css"` without Next's generated next-env.d.ts, so
// `pnpm typecheck` works on a fresh checkout before any build.
declare module "*.css";
