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
