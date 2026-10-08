import { describe, expect, it } from "vitest";
import { formatTime, priceText, quotaText, relativeTime } from "./format";

describe("platform formatting helpers", () => {
  it("renders quotas with unlimited support", () => {
    expect(quotaText(-1)).toBe("不限");
    expect(quotaText(200)).toBe("200");
  });

  it("renders prices in CNY", () => {
    expect(priceText(0, "CNY")).toBe("免费");
    expect(priceText(9900, "CNY")).toBe("¥99");
  });

  it("formats times and relative times", () => {
    expect(formatTime(undefined)).toBe("—");
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(relativeTime("2026-10-09T11:00:00Z", now)).toBe("1 小时前");
  });
});
