import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseChangelog } from "../src/lib/changelog";

const root = (name: string) => readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8");
const chapters = parseChangelog(root("CHANGELOG.md"));

test("two chapters, newest first, and the submission is in the second", () => {
  expect(chapters.map((c) => c.title)).toEqual(["After the hackathon", "Submitted for NEAR HACKATHON"]);
  expect(chapters[1]!.releases[0]!.tag).toBe("hackathon-submission");
  const dates = chapters.flatMap((c) => c.releases.map((r) => r.date));
  expect(dates).toEqual([...dates].sort().reverse());
  expect(chapters[0]!.releases.every((r) => r.date > "2026-11-14")).toBe(true);
});
test("it and the README list the same later releases", () => {
  const inReadme = [...root("README.md").matchAll(/^\| (v1\.\d+\.\d+) \|/gm)].map((m) => m[1]).sort();
  expect(chapters[0]!.releases.map((r) => r.tag).sort()).toEqual(inReadme);
});
test("a line it can't read stops the build", () => {
  expect(() => parseChangelog("## A\n- soon · v2 · x")).toThrow(/can't read/);
});
