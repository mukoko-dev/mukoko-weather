import { describe, expect, it } from "vitest";
import { WORKER_ORIGIN, workerUrl } from "./worker-url";

describe("workerUrl", () => {
  it("is the production Worker when nothing is set", () => {
    expect(workerUrl("/v1/tags", {})).toBe(`${WORKER_ORIGIN}/v1/tags`);
    expect(WORKER_ORIGIN).toBe("https://weather-api.mukoko.com");
  });

  it("keeps the path and query as given", () => {
    expect(workerUrl("/v1/activities?mode=categories", {})).toBe(
      "https://weather-api.mukoko.com/v1/activities?mode=categories",
    );
  });

  it("follows NEXT_PUBLIC_WEATHER_API_URL for a preview Worker", () => {
    expect(
      workerUrl("/v1/tags", {
        NEXT_PUBLIC_WEATHER_API_URL: "https://preview.example.dev",
      }),
    ).toBe("https://preview.example.dev/v1/tags");
  });

  it("ignores an unsafe override and uses the production Worker", () => {
    expect(
      workerUrl("/v1/tags", {
        NEXT_PUBLIC_WEATHER_API_URL: "http://evil.example.com",
      }),
    ).toBe(`${WORKER_ORIGIN}/v1/tags`);
  });
});
