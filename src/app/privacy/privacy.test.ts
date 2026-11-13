/**
 * The privacy page names every third party that receives data from us. MET
 * Norway is the failover forecast (mukoko-dev/mukoko-weather#434): the forecast
 * Worker sends it coordinates rounded to four decimals (its terms: five or more
 * is refused) and no IP address.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("privacy page: MET Norway", () => {
  const start = source.indexOf(">MET Norway</dt>");
  // JSX text is wrapped by the formatter: compare it as one line.
  const entry = source
    .slice(start, source.indexOf("</dd>", start))
    .replace(/\s+/g, " ");

  it("lists MET Norway as a third-party service", () => {
    expect(start).toBeGreaterThan(-1);
  });

  it("says when it is used and what is sent", () => {
    expect(entry).toContain("only when our main provider");
    expect(entry).toContain("rounded to four decimal places");
    expect(entry).toContain("Your IP address is");
    expect(entry).toContain("not forwarded");
    // Its own logs hold the coordinates (api.met.no/doc/TermsOfService,
    // "Personal data"): said plainly.
    expect(entry).toContain("request logs, kept in Norway");
    expect(entry).toContain("CC BY 4.0");
  });

  it("says the request comes from our service, not the browser", () => {
    expect(entry).toContain("Our own weather service (not your browser)");
  });

  it("links their terms of service", () => {
    expect(entry).toContain('href="https://api.met.no/doc/TermsOfService"');
  });
});

/**
 * The app keeps the last forecast shown on the home screen in localStorage so
 * the next open can paint it at once (mukoko-dev/mukoko-weather#551,
 * src/lib/home-snapshot.ts). The page says so, in the storage section and in
 * the retention list, and says it stays on the device.
 */
describe("privacy page: the stored forecast", () => {
  // JSX text is wrapped by the formatter: compare it as one line.
  const text = source.replace(/\s+/g, " ");

  it("says the app keeps a copy of the last forecast, on this device", () => {
    expect(text).toContain("keeps a copy of the last forecast it showed");
    expect(text).toContain("one place");
    expect(text).toContain("on this device");
  });

  it("says it is never sent to us and how to remove it", () => {
    expect(text).toContain("it is never sent to us");
    expect(text).toContain(
      "Clearing your browser&apos;s local storage removes it",
    );
    expect(text).toContain("signing out does not");
  });

  it("lists it in the data retention section", () => {
    const retention = text.slice(text.indexOf('heading="Data retention"'));
    expect(retention).toContain("The last forecast shown on your home screen");
    expect(retention).toContain("we never receive it");
  });
});
