import { describe, it, expect } from "vitest";
import { resolveScene } from "./resolve-scene";

describe("resolveScene", () => {
  describe("clear sky codes", () => {
    it("maps WMO 0 (Clear sky) to clear", () => {
      expect(resolveScene(0)).toBe("clear");
    });

    it("maps WMO 1 (Mainly clear) to clear", () => {
      expect(resolveScene(1)).toBe("clear");
    });
  });

  describe("cloud codes", () => {
    it("maps WMO 2 (Partly cloudy) to partly-cloudy", () => {
      expect(resolveScene(2)).toBe("partly-cloudy");
    });

    it("maps WMO 3 (Overcast) to cloudy", () => {
      expect(resolveScene(3)).toBe("cloudy");
    });
  });

  describe("fog codes", () => {
    it("maps WMO 45 (Fog) to fog", () => {
      expect(resolveScene(45)).toBe("fog");
    });

    it("maps WMO 48 (Depositing rime fog) to fog", () => {
      expect(resolveScene(48)).toBe("fog");
    });
  });

  describe("rain codes", () => {
    it.each([51, 53, 55])("maps drizzle code %d to rain", (code) => {
      expect(resolveScene(code)).toBe("rain");
    });

    it.each([61, 63, 65])("maps rain code %d to rain", (code) => {
      expect(resolveScene(code)).toBe("rain");
    });

    it.each([56, 57, 66, 67])("maps freezing rain code %d to rain", (code) => {
      expect(resolveScene(code)).toBe("rain");
    });

    it.each([80, 81, 82])("maps rain shower code %d to rain", (code) => {
      expect(resolveScene(code)).toBe("rain");
    });
  });

  describe("snow codes", () => {
    it.each([71, 73, 75, 77])("maps snow code %d to snow", (code) => {
      expect(resolveScene(code)).toBe("snow");
    });

    it.each([85, 86])("maps snow shower code %d to snow", (code) => {
      expect(resolveScene(code)).toBe("snow");
    });
  });

  describe("thunderstorm codes", () => {
    it.each([95, 96, 99])("maps thunderstorm code %d to thunderstorm", (code) => {
      expect(resolveScene(code)).toBe("thunderstorm");
    });
  });

  describe("unknown codes", () => {
    it("maps unknown code to partly-cloudy", () => {
      expect(resolveScene(999)).toBe("partly-cloudy");
    });

    it("maps negative code to partly-cloudy", () => {
      expect(resolveScene(-1)).toBe("partly-cloudy");
    });
  });

  describe("wind override", () => {
    it("overrides clear to windy when windSpeed > 40", () => {
      expect(resolveScene(0, 50)).toBe("windy");
    });

    it("overrides partly-cloudy to windy when windSpeed > 40", () => {
      expect(resolveScene(2, 45)).toBe("windy");
    });

    it("does not override cloudy even with high wind", () => {
      expect(resolveScene(3, 60)).toBe("cloudy");
    });

    it("does not override rain even with high wind", () => {
      expect(resolveScene(63, 50)).toBe("rain");
    });

    it("does not override at exactly 40 km/h", () => {
      expect(resolveScene(0, 40)).toBe("clear");
    });

    it("does not override when windSpeed is undefined", () => {
      expect(resolveScene(0)).toBe("clear");
    });
  });
});
