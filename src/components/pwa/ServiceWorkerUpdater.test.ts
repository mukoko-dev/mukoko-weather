/**
 * Tests for ServiceWorkerUpdater — validates the update-detection + auto-reload
 * logic and that it does NOT re-register the SW (@serwist/next already does).
 * Reads source file directly (source-string checks, repo Vitest style).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "ServiceWorkerUpdater.tsx"),
  "utf-8",
);
const layoutSource = readFileSync(
  resolve(__dirname, "../../app/layout.tsx"),
  "utf-8",
);
const nextConfigSource = readFileSync(
  resolve(__dirname, "../../../next.config.ts"),
  "utf-8",
);

describe("ServiceWorkerUpdater — component structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("exports ServiceWorkerUpdater function", () => {
    expect(source).toContain("export function ServiceWorkerUpdater");
  });

  it("renders null (no UI)", () => {
    expect(source).toContain("return null");
  });

  it("does not depend on the store or RxDB", () => {
    expect(source).not.toContain("useAppStore");
    expect(source).not.toContain("rxdb");
    expect(source).not.toContain("store");
  });
});

describe("ServiceWorkerUpdater — does NOT re-register the SW", () => {
  it("never calls register() — @serwist/next already registers the SW", () => {
    expect(source).not.toContain(".register(");
    expect(source).not.toContain("serviceWorker.register");
  });
});

describe("ServiceWorkerUpdater — feature detection / defensiveness", () => {
  it("guards on serviceWorker support", () => {
    expect(source).toContain('"serviceWorker" in navigator');
  });

  it("guards against undefined navigator (SSR-safe)", () => {
    expect(source).toContain('typeof navigator === "undefined"');
  });

  it("wraps side effects in try/catch", () => {
    expect(source).toContain("try {");
    expect(source).toContain("catch");
  });
});

describe("ServiceWorkerUpdater — auto-reload on controller swap", () => {
  it("listens for controllerchange", () => {
    expect(source).toContain('"controllerchange"');
  });

  it("reloads the page when a new SW takes control", () => {
    expect(source).toContain("window.location.reload()");
  });

  it("uses a module-level guard to reload at most once (no loops)", () => {
    expect(source).toMatch(/let reloaded = false/);
    expect(source).toContain("if (reloaded) return");
    expect(source).toContain("reloaded = true");
  });

  it("skips the initial claim when there was no controller at page load", () => {
    expect(source).toContain("hadControllerAtLoad");
    // reads navigator.serviceWorker.controller (aliased to sw) at page load
    expect(source).toContain("Boolean(sw.controller)");
    expect(source).toContain("if (!hadControllerAtLoad) return");
  });
});

describe("ServiceWorkerUpdater — update checks", () => {
  it("calls registration.update() to check for a new SW", () => {
    expect(source).toContain("getRegistration()");
    expect(source).toContain(".update()");
  });

  it("re-checks when the document becomes visible", () => {
    expect(source).toContain('"visibilitychange"');
    expect(source).toContain('document.visibilityState === "visible"');
  });

  it("re-checks on window focus", () => {
    expect(source).toContain('"focus"');
  });

  it("checks once on mount", () => {
    expect(source).toContain("checkForUpdate()");
  });

  it("cleans up its listeners on unmount", () => {
    expect(source).toContain("removeEventListener");
  });
});

describe("ServiceWorkerUpdater — mounted in layout", () => {
  it("is imported in the root layout", () => {
    expect(layoutSource).toContain("ServiceWorkerUpdater");
    expect(layoutSource).toContain(
      '@/components/pwa/ServiceWorkerUpdater',
    );
  });

  it("is rendered in the layout tree", () => {
    expect(layoutSource).toContain("<ServiceWorkerUpdater />");
  });
});

describe("next.config.ts — /sw.js is never cached", () => {
  it("adds a no-store Cache-Control header for /sw.js", () => {
    expect(nextConfigSource).toContain("/sw.js");
    expect(nextConfigSource).toContain("no-cache, no-store, must-revalidate");
  });

  it("sets Service-Worker-Allowed to root scope", () => {
    expect(nextConfigSource).toContain("Service-Worker-Allowed");
  });

  it("keeps the existing embed + API header blocks intact", () => {
    expect(nextConfigSource).toContain("/embed/:path*");
    expect(nextConfigSource).toContain("/api/:path*");
  });
});
