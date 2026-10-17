/**
 * Regression guard for the v0.10.0 hydration failure (React error #418 on
 * every page, then `$RS … reading 'parentNode'`).
 *
 * Cause, measured on production: Cloudflare Fonts rewrites a
 * `<link rel="stylesheet" href="https://fonts.googleapis.com/…">` in <head>
 * into an inline `<style>` of @font-face rules served from /cf-fonts/. React
 * hydrates <head>, finds a <style> where it rendered a <link>, throws #418
 * and discards the server HTML for a full client render — while the
 * streamed Suspense segments still try to swap in, which is the parentNode
 * error. Self-hosting the fonts through next/font removes the link, so
 * there is nothing for the edge to rewrite (and no render-blocking
 * cross-origin CSS request either).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const layout = readFileSync(resolve(__dirname, "layout.tsx"), "utf-8");
const css = readFileSync(resolve(__dirname, "globals.css"), "utf-8");

describe("root layout fonts are self-hosted (no edge-rewritable <link>)", () => {
  it("renders no Google Fonts stylesheet or preconnect link", () => {
    expect(layout).not.toMatch(/<link[^>]*fonts\.googleapis\.com/);
    expect(layout).not.toMatch(/<link[^>]*fonts\.gstatic\.com/);
  });

  it("loads Noto Sans, Noto Serif and JetBrains Mono through next/font/google", () => {
    expect(layout).toContain(
      'import { Noto_Sans, Noto_Serif, JetBrains_Mono } from "next/font/google";',
    );
    for (const v of [
      "--font-noto-sans",
      "--font-noto-serif",
      "--font-jetbrains-mono",
    ]) {
      expect(layout).toContain(`variable: "${v}"`);
    }
  });

  it("puts the font variables on <html>", () => {
    expect(layout).toContain(
      "className={`${notoSans.variable} ${notoSerif.variable} ${jetbrainsMono.variable}`}",
    );
  });

  it("the theme font stacks lead with the next/font families", () => {
    expect(css).toMatch(/--font-sans:\s*var\(--font-noto-sans\)/);
    expect(css).toContain(
      '--font-heading: var(--font-noto-serif), "Noto Serif"',
    );
    expect(css).toContain(
      '--font-display: var(--font-noto-serif), "Noto Serif"',
    );
    expect(css).toMatch(
      /--font-mono:\s*var\(--font-jetbrains-mono\), "JetBrains Mono"/,
    );
  });
});
