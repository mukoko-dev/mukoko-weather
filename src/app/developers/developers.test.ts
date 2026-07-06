/**
 * Tests for the /developers page — validates metadata, canonical URL,
 * JSON-LD, documented public endpoints, and site-style layout by reading
 * the source file (Vitest runs in Node).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const pageSource = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");

describe("developers page — metadata", () => {
  it("exports a Developers-focused title", () => {
    expect(pageSource).toContain("Developers & Public API");
  });

  it("sets the canonical URL to /developers", () => {
    expect(pageSource).toContain("https://weather.mukoko.com/developers");
    expect(pageSource).toContain("canonical:");
  });
});

describe("developers page — structure", () => {
  it("is a server component (no use client directive)", () => {
    expect(pageSource).not.toContain('"use client"');
  });

  it("is an async server component that reads auth state", () => {
    expect(pageSource).toContain("export default async function");
    expect(pageSource).toContain("getCurrentUser");
    expect(pageSource).toContain("@/lib/auth");
  });

  it("renders the shared Header and Footer", () => {
    expect(pageSource).toContain("Header");
    expect(pageSource).toContain("Footer");
  });

  it("includes JSON-LD structured data (TechArticle)", () => {
    expect(pageSource).toContain("application/ld+json");
    expect(pageSource).toContain("TechArticle");
  });

  it("uses the fauna section-heading class (eagle)", () => {
    expect(pageSource).toContain("eagle");
  });

  it("uses the fauna code-block surface class (tortoise)", () => {
    expect(pageSource).toContain("tortoise");
  });

  it("links to the embed page for the widget", () => {
    expect(pageSource).toContain('href="/embed"');
  });
});

describe("developers page — documented public endpoints", () => {
  const endpoints = [
    "/api/embed/current",
    "/api/py/weather?lat=",
    "/api/py/geo?lat=",
    "/api/py/locations?slug=",
    "/api/py/search?q=",
    "/api/py/airquality?lat=",
    "/api/py/airports/nearest?lat=",
  ];

  it.each(endpoints)("documents %s", (endpoint) => {
    expect(pageSource).toContain(endpoint);
  });

  it("notes the open CORS policy", () => {
    expect(pageSource).toContain("Access-Control-Allow-Origin: *");
  });

  it("mentions the weather provider response headers", () => {
    expect(pageSource).toContain("X-Weather-Provider");
    expect(pageSource).toContain("X-Current-Source");
  });

  it("links to Shamwari for the AI endpoints, gated behind the shamwari_chat feature flag", () => {
    expect(pageSource).toContain('href="/shamwari"');
    expect(pageSource).toContain('isFeatureEnabled("shamwari_chat")');
  });

  it("includes a terms / fair use note", () => {
    expect(pageSource).toContain("fair use");
  });
});

describe("developers page — optional API keys", () => {
  it("leads with the free-and-open, no-key-needed message", () => {
    expect(pageSource).toContain(
      "The API is free and open — call it directly, no key needed.",
    );
  });

  it("has an optional API keys section", () => {
    expect(pageSource).toContain("API keys (optional)");
  });

  it("shows a Manage API keys CTA for signed-in users", () => {
    expect(pageSource).toContain("Manage API keys");
    expect(pageSource).toContain('href="/developers/keys"');
  });

  it("shows a sign-in CTA (with returnTo) for anonymous users", () => {
    expect(pageSource).toContain("Sign in to create an API key");
    expect(pageSource).toContain(
      'href="/auth/signin?returnTo=/developers/keys"',
    );
  });
});
