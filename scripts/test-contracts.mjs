#!/usr/bin/env node
// Runs the vault's Rust tests as part of `pnpm test`, so one command covers the whole
// repo: unit tests on a mocked chain, then sandbox tests on a real local NEAR node.
// A laptop without the Rust toolchain skips with a warning. CI never skips: a missing
// toolchain there is a failure.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { ensureSandbox } from "./near-sandbox.mjs";

const manifest = "contracts/vault/Cargo.toml";
const ci = Boolean(process.env.CI);

function skip(reason) {
  if (ci) {
    console.error(`contract tests: FAILED, ${reason} on CI`);
    process.exit(1);
  }
  console.warn(`contract tests: NOT RUN, ${reason}. These results do not cover the vault.`);
  process.exit(0);
}

if (!existsSync(manifest)) {
  console.log(`contract tests: skipped, ${manifest} does not exist yet`);
  process.exit(0);
}

if (spawnSync("cargo", ["--version"], { stdio: "ignore" }).error) skip("cargo is not installed");

const targets = spawnSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" });
const hasWasm = targets.stdout?.split("\n").includes("wasm32-unknown-unknown") ?? false;

const env = { ...process.env };
let args = ["test", "--manifest-path", manifest];
if (!hasWasm) {
  // The unit tests need no wasm; the sandbox tests deploy the real contract.
  if (ci) skip("the wasm32-unknown-unknown target is not installed");
  console.warn("contract tests: unit tests only. For the sandbox tests: rustup target add wasm32-unknown-unknown");
  args = [...args, "--lib"];
} else if (!env.NEAR_SANDBOX_BIN_PATH) {
  const path = await ensureSandbox();
  if (path !== null) env.NEAR_SANDBOX_BIN_PATH = path;
}

const { status } = spawnSync("cargo", args, { stdio: "inherit", env });
process.exit(status ?? 1);
