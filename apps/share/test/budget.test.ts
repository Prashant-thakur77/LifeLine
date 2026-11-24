import { expect, test } from "vitest";
import { createBudget } from "../src/budget";

test("a minute's and a day's worth, and no more", () => {
  const ok = createBudget({ perMinute: 2, perDay: 3 });
  expect([ok(0), ok(1), ok(2)]).toEqual([true, true, false]);
  expect(ok(60_001)).toBe(true);
  expect(ok(200_000)).toBe(false);
  expect(ok(86_400_002)).toBe(true);
});
