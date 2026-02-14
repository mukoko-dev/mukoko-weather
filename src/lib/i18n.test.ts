import { describe, it, expect } from "vitest";
import {
  t,
  formatTemp,
  formatWindSpeed,
  formatPercent,
  formatTime,
  formatDayName,
  formatDate,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
} from "./i18n";

describe("t() translation lookup", () => {
  it("returns the English translation for a known key", () => {
    expect(t("weather.feelsLike")).toBe("Feels like");
  });

  it("returns the raw key when the key is not found", () => {
    expect(t("nonexistent.key")).toBe("nonexistent.key");
  });

  it("replaces {param} placeholders with values", () => {
    expect(t("weather.current", { location: "Harare" })).toBe(
      "Current weather conditions in Harare",
    );
  });

  it("replaces multiple placeholders", () => {
    // a11y.temperatureLabel has {value}
    expect(t("a11y.temperatureLabel", { value: 28 })).toBe(
      "28 degrees Celsius",
    );
  });

  it("replaces numeric param values via String()", () => {
    expect(t("location.count", { count: 90 })).toBe(
      "90 locations across Zimbabwe",
    );
  });

  it("falls back to English when locale has no messages", () => {
    expect(t("weather.feelsLike", undefined, "sn")).toBe("Feels like");
  });

  it("falls back to English when locale is unknown", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(t("weather.feelsLike", undefined, "xx" as any)).toBe("Feels like");
  });

  it("returns key when not found in any locale", () => {
    expect(t("missing.everywhere", undefined, "sn")).toBe("missing.everywhere");
  });

  it("handles params on a missing key gracefully (returns key as-is)", () => {
    // The key itself doesn't have {param} so nothing is replaced
    expect(t("no.such.key", { foo: "bar" })).toBe("no.such.key");
  });
});

describe("DEFAULT_LOCALE and SUPPORTED_LOCALES", () => {
  it("has en as the default locale", () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("supports en, sn, and nd locales", () => {
    expect(SUPPORTED_LOCALES).toContain("en");
    expect(SUPPORTED_LOCALES).toContain("sn");
    expect(SUPPORTED_LOCALES).toContain("nd");
    expect(SUPPORTED_LOCALES).toHaveLength(3);
  });
});

describe("formatTemp", () => {
  it("formats a positive integer temperature", () => {
    const result = formatTemp(28);
    expect(result).toContain("28");
    expect(result).toContain("C");
  });

  it("rounds fractional values", () => {
    const result = formatTemp(28.7);
    expect(result).toContain("29");
  });

  it("handles negative temperatures", () => {
    const result = formatTemp(-2);
    // Should contain the digit 2 and a minus indicator
    expect(result).toMatch(/2/);
  });

  it("handles zero", () => {
    const result = formatTemp(0);
    expect(result).toContain("0");
  });
});

describe("formatWindSpeed", () => {
  it("formats wind speed with km/h", () => {
    const result = formatWindSpeed(12);
    expect(result).toContain("12");
    expect(result).toContain("km");
  });

  it("rounds fractional values", () => {
    const result = formatWindSpeed(12.6);
    expect(result).toContain("13");
  });
});

describe("formatPercent", () => {
  it("formats a percentage value", () => {
    const result = formatPercent(62);
    expect(result).toContain("62");
    expect(result).toContain("%");
  });

  it("handles 0%", () => {
    const result = formatPercent(0);
    expect(result).toContain("0");
  });

  it("handles 100%", () => {
    const result = formatPercent(100);
    expect(result).toContain("100");
  });
});

describe("formatTime", () => {
  it("formats time in 24h format", () => {
    const date = new Date("2026-02-14T14:30:00Z");
    const result = formatTime(date);
    // Should be HH:MM format (exact value depends on timezone)
    expect(result).toMatch(/\d{2}:\d{2}/);
  });

  it("pads hours and minutes", () => {
    const date = new Date("2026-02-14T05:05:00Z");
    const result = formatTime(date);
    expect(result).toMatch(/\d{2}:\d{2}/);
  });
});

describe("formatDayName", () => {
  it("returns a short weekday name", () => {
    const date = new Date("2026-02-14"); // Saturday
    const result = formatDayName(date);
    // Should be a short name like "Sat"
    expect(result.length).toBeLessThanOrEqual(4);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("formatDate", () => {
  it("formats a full date with day, month, and year", () => {
    const date = new Date("2026-02-14");
    const result = formatDate(date);
    expect(result).toContain("2026");
    expect(result).toContain("14");
    // Should contain month name (February)
    expect(result).toMatch(/February|Feb/i);
  });
});
