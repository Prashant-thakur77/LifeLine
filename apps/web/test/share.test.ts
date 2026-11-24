import { expect, test } from "vitest";
import { shareCardUrl, shareOnXHref } from "../src/lib/share";

test("a share link holds the address and nothing else", () => {
  expect(shareCardUrl(" 0xAB ")).toBe("https://lifeline-share.prashantthakur.dev/0xab");
  expect(new URL(shareOnXHref("0xAB")).searchParams.get("url")).toBe(shareCardUrl("0xAB"));
});
