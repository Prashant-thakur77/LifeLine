#!/usr/bin/env node
// Runs the vault's Rust tests as part of `pnpm test`, so one command covers
// the whole repo. B's checklist has no Rust, so a laptop without cargo skips
// with a warning. CI never skips: a missing toolchain there is a failure.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const manifest = "contracts/vault/Cargo.toml";

if (!existsSync(manifest)) {
  console.log(`contract tests: skipped, ${manifest} does not exist yet`);
  process.exit(0);
}

if (spawnSync("cargo", ["--version"], { stdio: "ignore" }).error) {
  if (process.env.CI) {
    console.error("contract tests: FAILED, cargo is not installed on CI");
    process.exit(1);
  }
  console.warn(
    "contract tests: NOT RUN, cargo is not installed. These results do not cover the vault.",
  );
  process.exit(0);
}

const { status } = spawnSync(
  "cargo",
  ["test", "--manifest-path", manifest],
  { stdio: "inherit" },
);
process.exit(status ?? 1);
