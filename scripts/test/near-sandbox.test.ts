import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { byteRanges, platformDir, s3Etag, sandboxPath, sandboxUrl } from "../near-sandbox.mjs";

describe("fetching the NEAR sandbox", () => {
  it("covers every byte exactly once, in at most the parts asked for", () => {
    expect(byteRanges(10, 3)).toEqual([
      [0, 3],
      [4, 7],
      [8, 9],
    ]);
    const ranges = byteRanges(35_582_480, 16);
    expect(ranges).toHaveLength(16);
    expect(ranges[0]?.[0]).toBe(0);
    expect(ranges.at(-1)?.[1]).toBe(35_582_479);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]?.[0]).toBe((ranges[i - 1]?.[1] ?? 0) + 1);
  });

  it("computes S3's ETag for a single upload, and for a multipart one", () => {
    const data = Buffer.from("x".repeat(25));
    expect(s3Etag(data, false)).toBe(createHash("md5").update(data).digest("hex"));
    const parts = [data.subarray(0, 10), data.subarray(10, 20), data.subarray(20)].map((p) => createHash("md5").update(p).digest());
    expect(s3Etag(data, true, 10)).toBe(`${createHash("md5").update(Buffer.concat(parts)).digest("hex")}-3`);
  });

  it("knows nearcore's builds, and says when there is none", () => {
    expect(platformDir("linux", "x64")).toBe("Linux-x86_64");
    expect(platformDir("darwin", "arm64")).toBe("Darwin-arm64");
    expect(platformDir("win32", "x64")).toBeNull();
  });

  it("downloads the version near-workspaces expects, into the home folder", () => {
    expect(sandboxUrl("Linux-x86_64")).toBe(
      "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.14.0/near-sandbox.tar.gz",
    );
    expect(sandboxPath("Linux-x86_64", "/home/judge")).toBe("/home/judge/.near-sandbox/2.14.0/Linux-x86_64/near-sandbox");
  });
});
