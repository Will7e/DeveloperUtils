import { describe, it, expect } from "vitest";
import { describeRelativeTime, formatRelativeTime } from "./relative-time";

const NOW = Date.parse("2026-09-22T12:00:00Z");
const minutes = (n: number) => NOW - n * 60_000;

describe("formatRelativeTime", () => {
  it("counts up through minutes, hours and days", () => {
    expect(formatRelativeTime(minutes(0), NOW)).toBe("now");
    expect(formatRelativeTime(minutes(12), NOW)).toBe("12m");
    expect(formatRelativeTime(minutes(59), NOW)).toBe("59m");
    expect(formatRelativeTime(minutes(60), NOW)).toBe("1h");
    expect(formatRelativeTime(minutes(60 * 23), NOW)).toBe("23h");
    expect(formatRelativeTime(minutes(60 * 24), NOW)).toBe("1d");
    expect(formatRelativeTime(minutes(60 * 24 * 6), NOW)).toBe("6d");
  });

  it("gives a real date past a week, where a day count stops meaning anything", () => {
    const old = formatRelativeTime(minutes(60 * 24 * 30), NOW);
    expect(old).not.toMatch(/^\d+d$/);
    expect(old).toMatch(/[A-Za-z]/);
  });

  it("says nothing at all for a timestamp it cannot read", () => {
    // A repo that has never been pushed has no time, and "NaN" in the gutter
    // is worse than an empty one.
    expect(formatRelativeTime(0, NOW)).toBe("");
    expect(formatRelativeTime(Number.NaN, NOW)).toBe("");
  });

  it("does not report the future as a negative age", () => {
    // Clock skew between the browser and GitHub is ordinary.
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe("now");
  });
});

describe("describeRelativeTime", () => {
  it("spells out the same age for a tooltip", () => {
    expect(describeRelativeTime(minutes(0), NOW)).toBe("just now");
    expect(describeRelativeTime(minutes(1), NOW)).toBe("last updated 1 minute ago");
    expect(describeRelativeTime(minutes(30), NOW)).toBe("last updated 30 minutes ago");
    expect(describeRelativeTime(minutes(60 * 5), NOW)).toBe("last updated 5 hours ago");
    expect(describeRelativeTime(minutes(60 * 24 * 2), NOW)).toBe("last updated 2 days ago");
  });

  it("falls back to the short form for a date", () => {
    const described = describeRelativeTime(minutes(60 * 24 * 30), NOW);
    expect(described).toContain("last updated");
    expect(described).not.toContain("undefined");
  });
});
