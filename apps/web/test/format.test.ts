import { describe, expect, it } from "vitest";
import {
  formatCountdown,
  formatHealth,
  formatLatency,
  formatPrice,
  formatSeconds,
  formatUnits,
  formatUsd,
  parseUnits,
  shortMiddle,
  timeAgo,
} from "../src/lib/format";

describe("formatUsd", () => {
  it("formats dollars with cents and separators", () => {
    expect(formatUsd(184.6)).toBe("$184.60");
    expect(formatUsd(12345.678)).toBe("$12,345.68");
    expect(formatUsd(-3.2)).toBe("-$3.20");
  });
  it("shows a dash for anything that isn't a finite number", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
    expect(formatUsd(Number.NaN)).toBe("—");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatHealth", () => {
  it("uses two decimals", () => {
    expect(formatHealth(1.4388489208633093)).toBe("1.44");
    expect(formatHealth(2)).toBe("2.00");
  });
  it("shows no positions as ∞ and a missing reading as a dash", () => {
    expect(formatHealth(Number.POSITIVE_INFINITY)).toBe("∞");
    expect(formatHealth(null)).toBe("—");
    expect(formatHealth(undefined)).toBe("—");
    expect(formatHealth(Number.NaN)).toBe("—");
  });
});

describe("formatPrice", () => {
  it("keeps cents for big prices and more digits for small ones", () => {
    expect(formatPrice(2055.994897959184)).toBe("2,055.99");
    expect(formatPrice(3.14159)).toBe("3.1416");
    expect(formatPrice(0.000312345678)).toBe("0.000312346");
    expect(formatPrice(null)).toBe("—");
  });
});

describe("formatUnits", () => {
  it("rounds base units half up", () => {
    expect(formatUnits("3469653", 6)).toBe("3.47");
    expect(formatUnits("18056800", 6)).toBe("18.06");
    expect(formatUnits("25000000", 6)).toBe("25.00");
    expect(formatUnits("4995", 6)).toBe("0.00");
    expect(formatUnits("5000", 6)).toBe("0.01");
  });
  it("groups thousands and handles big decimals without floats", () => {
    expect(formatUnits("1234567890000", 6)).toBe("1,234,567.89");
    expect(formatUnits("1500000000000000000000000", 24)).toBe("1.50");
    expect(formatUnits("123456789012345678901234567890", 24, 4)).toBe("123,456.7890");
  });
  it("works when the token has fewer decimals than asked for", () => {
    expect(formatUnits("42", 0)).toBe("42");
    expect(formatUnits("125", 1)).toBe("12.5");
  });
  it("refuses anything that isn't a whole number", () => {
    expect(formatUnits("1.5", 6)).toBe("—");
    expect(formatUnits("-1", 6)).toBe("—");
    expect(formatUnits("", 6)).toBe("—");
  });
});

describe("parseUnits", () => {
  it("turns a typed amount into base units", () => {
    expect(parseUnits("2.5", 6)).toEqual({ ok: true, base: "2500000" });
    expect(parseUnits("25", 6)).toEqual({ ok: true, base: "25000000" });
    expect(parseUnits(" .5 ", 6)).toEqual({ ok: true, base: "500000" });
    expect(parseUnits("1.", 6)).toEqual({ ok: true, base: "1000000" });
    expect(parseUnits("0.000001", 6)).toEqual({ ok: true, base: "1" });
    expect(parseUnits("1.000000000000000000000001", 24)).toEqual({ ok: true, base: "1000000000000000000000001" });
  });
  it("round-trips with formatUnits", () => {
    const parsed = parseUnits("1234.56", 6);
    expect(parsed.ok && formatUnits(parsed.base, 6)).toBe("1,234.56");
  });
  it("refuses too many decimals, signs, exponents and words", () => {
    expect(parseUnits("0.0000001", 6)).toEqual({ ok: false, error: "At most 6 decimal places." });
    expect(parseUnits("1.5", 0)).toEqual({ ok: false, error: "This token has no decimal places." });
    for (const bad of ["", "-1", "1e6", "abc", "1,000", "1.2.3", "."]) {
      expect(parseUnits(bad, 6).ok, bad).toBe(false);
    }
  });
});

describe("formatLatency", () => {
  it("picks a unit that reads well", () => {
    expect(formatLatency(5668)).toBe("5.7 s");
    expect(formatLatency(42_000)).toBe("42 s");
    expect(formatLatency(300_000)).toBe("5 min");
  });
  it("shows a dash before there are samples", () => {
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(-1)).toBe("—");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-11-08T15:00:00.000Z");
  it("counts back from now", () => {
    expect(timeAgo("2026-11-08T14:59:58.000Z", now)).toBe("just now");
    expect(timeAgo("2026-11-08T14:59:30.000Z", now)).toBe("30 s ago");
    expect(timeAgo("2026-11-08T14:41:52.000Z", now)).toBe("18 min ago");
    expect(timeAgo("2026-11-08T12:00:00.000Z", now)).toBe("3 h ago");
    expect(timeAgo("2026-11-06T15:00:00.000Z", now)).toBe("2 d ago");
  });
  it("treats a future time as just now and garbage as unknown", () => {
    expect(timeAgo("2026-11-08T15:00:30.000Z", now)).toBe("just now");
    expect(timeAgo("not a date", now)).toBe("—");
  });
});

describe("formatCountdown", () => {
  it("shows minutes and seconds, never below zero", () => {
    expect(formatCountdown(600_000)).toBe("10:00");
    expect(formatCountdown(61_500)).toBe("1:02");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});

describe("shortMiddle", () => {
  it("shortens long addresses and leaves short ones", () => {
    expect(shortMiddle("0x1111111111111111111111111111111111111111")).toBe("0x1111…1111");
    expect(shortMiddle("demo.near")).toBe("demo.near");
  });
});

describe("formatSeconds", () => {
  it("uses the largest whole unit", () => {
    expect(formatSeconds(120)).toBe("2 min");
    expect(formatSeconds(90)).toBe("90 s");
    expect(formatSeconds(3600)).toBe("1 h");
    expect(formatSeconds(30)).toBe("30 s");
  });
});
