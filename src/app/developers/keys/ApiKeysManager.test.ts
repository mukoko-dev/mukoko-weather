/**
 * Structural tests for the ApiKeysManager client component + gated page.
 *
 * Vitest runs in a Node environment (no DOM), so we assert on the source:
 * correct endpoints, the one-time reveal + copy affordance, brand/fauna
 * styling (no hardcoded hex), accessibility hooks, and the page-level gate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const manager = readFileSync(resolve(__dirname, "ApiKeysManager.tsx"), "utf-8");
const page = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");

describe("ApiKeysManager component", () => {
  it("is a client component", () => {
    expect(manager).toContain('"use client"');
  });

  it("uses the gated /api/keys endpoints for list, create, and revoke", () => {
    expect(manager).toContain('fetch("/api/keys"');
    expect(manager).toContain('method: "POST"');
    expect(manager).toContain("`/api/keys/${id}`");
    expect(manager).toContain('method: "DELETE"');
  });

  it("shows the full key once with a copy button and a warning", () => {
    expect(manager).toContain("won&apos;t be able to see this");
    expect(manager).toContain("clipboard.writeText");
    expect(manager).toContain("Copy API key to clipboard");
  });

  it("caps keys at 10 and disables create at capacity", () => {
    expect(manager).toContain("MAX_KEYS = 10");
    expect(manager).toContain("atCapacity");
  });

  it("handles the entity-required state (guidance + disabled create)", () => {
    expect(manager).toContain("entityRequired");
    // Reads the flag from GET and reacts to a 403 on create.
    expect(manager).toContain("entityRequired?: boolean");
    expect(manager).toContain("res.status === 403");
    // Renders a registration/claim link.
    expect(manager).toContain("Register or claim an entity");
    // Create is blocked while no eligible entity exists.
    expect(manager).toContain("atCapacity || entityRequired");
  });

  it("uses fauna classes / brand tokens and no hardcoded hex colours", () => {
    expect(manager).toMatch(/\bbaobab\b|\bacacia\b|\bkudu-sm\b|\bimpala\b/);
    // No hardcoded hex colours in the component.
    expect(manager).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    // No inline style objects.
    expect(manager).not.toContain("style={{");
  });

  it("has accessibility affordances (aria-label / aria-labelledby / role)", () => {
    expect(manager).toContain("aria-labelledby");
    expect(manager).toContain("aria-label");
    expect(manager).toContain('role="alert"');
  });
});

describe("gated page", () => {
  it("requires an authenticated user and returns to the keys page after sign-in", () => {
    expect(page).toContain("requireUser");
    expect(page).toContain('"/developers/keys"');
  });

  it("renders within the site shell (Header + Footer)", () => {
    expect(page).toContain("<Header />");
    expect(page).toContain("<Footer />");
  });

  it("is excluded from search indexing", () => {
    expect(page).toContain("index: false");
  });
});
