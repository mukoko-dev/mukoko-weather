import { describe, it, expect } from "vitest";
import {
  humidityLabel,
  pressureLabel,
  cloudLabel,
  feelsLikeContext,
} from "./weather-labels";

describe("humidityLabel", () => {
  it("returns 'Dry' for 0%", () => {
    expect(humidityLabel(0)).toBe("Dry");
  });

  it("returns 'Dry' for exactly 30%", () => {
    expect(humidityLabel(30)).toBe("Dry");
  });

  it("returns 'Comfortable' for 31%", () => {
    expect(humidityLabel(31)).toBe("Comfortable");
  });

  it("returns 'Comfortable' for exactly 60%", () => {
    expect(humidityLabel(60)).toBe("Comfortable");
  });

  it("returns 'Humid' for 61%", () => {
    expect(humidityLabel(61)).toBe("Humid");
  });

  it("returns 'Humid' for exactly 80%", () => {
    expect(humidityLabel(80)).toBe("Humid");
  });

  it("returns 'Very humid' for 81%", () => {
    expect(humidityLabel(81)).toBe("Very humid");
  });

  it("returns 'Very humid' for 100%", () => {
    expect(humidityLabel(100)).toBe("Very humid");
  });
});

describe("pressureLabel", () => {
  it("returns 'Low' for 999 hPa", () => {
    expect(pressureLabel(999)).toBe("Low");
  });

  it("returns 'Normal' for exactly 1000 hPa", () => {
    expect(pressureLabel(1000)).toBe("Normal");
  });

  it("returns 'Normal' for exactly 1020 hPa", () => {
    expect(pressureLabel(1020)).toBe("Normal");
  });

  it("returns 'High' for 1021 hPa", () => {
    expect(pressureLabel(1021)).toBe("High");
  });

  it("returns 'Low' for very low pressure (950 hPa)", () => {
    expect(pressureLabel(950)).toBe("Low");
  });

  it("returns 'High' for very high pressure (1050 hPa)", () => {
    expect(pressureLabel(1050)).toBe("High");
  });
});

describe("cloudLabel", () => {
  it("returns 'Clear' for 0%", () => {
    expect(cloudLabel(0)).toBe("Clear");
  });

  it("returns 'Clear' for exactly 10%", () => {
    expect(cloudLabel(10)).toBe("Clear");
  });

  it("returns 'Mostly clear' for 11%", () => {
    expect(cloudLabel(11)).toBe("Mostly clear");
  });

  it("returns 'Mostly clear' for exactly 30%", () => {
    expect(cloudLabel(30)).toBe("Mostly clear");
  });

  it("returns 'Partly cloudy' for 31%", () => {
    expect(cloudLabel(31)).toBe("Partly cloudy");
  });

  it("returns 'Partly cloudy' for exactly 70%", () => {
    expect(cloudLabel(70)).toBe("Partly cloudy");
  });

  it("returns 'Mostly cloudy' for 71%", () => {
    expect(cloudLabel(71)).toBe("Mostly cloudy");
  });

  it("returns 'Mostly cloudy' for exactly 90%", () => {
    expect(cloudLabel(90)).toBe("Mostly cloudy");
  });

  it("returns 'Overcast' for 91%", () => {
    expect(cloudLabel(91)).toBe("Overcast");
  });

  it("returns 'Overcast' for 100%", () => {
    expect(cloudLabel(100)).toBe("Overcast");
  });
});

describe("feelsLikeContext", () => {
  it("returns 'Cooler than actual' when apparent < actual", () => {
    expect(feelsLikeContext(22, 25)).toBe("Cooler than actual");
  });

  it("returns 'Warmer than actual' when apparent > actual", () => {
    expect(feelsLikeContext(28, 25)).toBe("Warmer than actual");
  });

  it("returns 'Same as actual' when temperatures are equal", () => {
    expect(feelsLikeContext(25, 25)).toBe("Same as actual");
  });

  it("handles small differences correctly", () => {
    expect(feelsLikeContext(24.9, 25)).toBe("Cooler than actual");
    expect(feelsLikeContext(25.1, 25)).toBe("Warmer than actual");
  });
});
