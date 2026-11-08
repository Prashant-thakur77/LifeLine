#!/usr/bin/env node
// Fetches the NEAR sandbox node that the vault's sandbox tests run on, and prints its path.
// near-workspaces would download it itself, one stream from S3, which can take 20 minutes;
// this asks for 16 byte ranges at once and checks the result against S3's own hash.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Must match near-sandbox's DEFAULT_NEAR_SANDBOX_VERSION, which near-workspaces 0.24 uses. */
export const SANDBOX_VERSION = "2.14.0";
const PARTS = 16;
const S3_PART_BYTES = 8 * 1024 * 1024;

/** nearcore's name for this machine's build, or null where there is none. */
export function platformDir(platform = process.platform, arch = process.arch) {
  if (platform === "linux" && arch === "x64") return "Linux-x86_64";
  if (platform === "darwin" && arch === "arm64") return "Darwin-arm64";
  return null;
}

export function sandboxUrl(platform, version = SANDBOX_VERSION) {
  return `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/${platform}/${version}/near-sandbox.tar.gz`;
}

/** Inclusive byte ranges that cover `size` bytes in `parts` pieces. */
export function byteRanges(size, parts) {
  const chunk = Math.ceil(size / parts);
  const ranges = [];
  for (let start = 0; start < size; start += chunk) ranges.push([start, Math.min(start + chunk, size) - 1]);
  return ranges;
}

/** S3's ETag for `data`: a plain MD5, or for a multipart upload the MD5 of the parts' MD5s, then "-<parts>". */
export function s3Etag(data, multipart, partBytes = S3_PART_BYTES) {
  if (!multipart) return createHash("md5").update(data).digest("hex");
  const digests = [];
  for (let start = 0; start < data.length; start += partBytes) {
    digests.push(createHash("md5").update(data.subarray(start, start + partBytes)).digest());
  }
  return `${createHash("md5").update(Buffer.concat(digests)).digest("hex")}-${digests.length}`;
}

/** One byte range, retried: with 16 connections open, one of them failing is normal. */
async function fetchRange(url, start, end, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(300_000) });
      if (response.status !== 206) throw new Error(`status ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= attempts) throw new Error(`the download of bytes ${start}-${end} failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

export function sandboxPath(platform, home = homedir(), version = SANDBOX_VERSION) {
  return join(home, ".near-sandbox", version, platform, "near-sandbox");
}

/** Downloads, checks and unpacks the sandbox if it isn't here yet. Returns its path, or null if this machine has no build. */
export async function ensureSandbox({ log = console.error } = {}) {
  const platform = platformDir();
  if (platform === null) return null;
  const path = sandboxPath(platform);
  if (existsSync(path)) return path;

  const url = sandboxUrl(platform);
  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) throw new Error(`the sandbox isn't at ${url}: ${head.status}`);
  const size = Number(head.headers.get("content-length"));
  const etag = (head.headers.get("etag") ?? "").replaceAll('"', "");
  log(`Downloading the NEAR sandbox ${SANDBOX_VERSION} (${(size / 1e6).toFixed(1)} MB) in ${PARTS} parts...`);

  const pieces = await Promise.all(byteRanges(size, PARTS).map(([start, end]) => fetchRange(url, start, end)));
  const archive = Buffer.concat(pieces);
  const actual = s3Etag(archive, etag.includes("-"));
  if (archive.length !== size || actual !== etag) throw new Error(`the sandbox download is corrupt: expected ${etag}, got ${actual}`);

  const dir = join(homedir(), ".near-sandbox", SANDBOX_VERSION);
  mkdirSync(dir, { recursive: true });
  const tarball = join(dir, "near-sandbox.tar.gz");
  writeFileSync(tarball, archive);
  const untar = spawnSync("tar", ["xzf", tarball, "-C", dir], { stdio: "inherit" });
  if (untar.status !== 0 || !existsSync(path)) throw new Error("couldn't unpack the sandbox");
  log(`Sandbox ready at ${path}`);
  return path;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = await ensureSandbox();
  console.log(path ?? "no sandbox build for this machine: near-workspaces will try its own download");
}
