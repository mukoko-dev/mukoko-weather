/**
 * SafeMarkdown — link sanitisation and error isolation shared by every AI
 * surface (AI summary, follow-up chat, history analysis, explore chatbot).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isSafeHref, SafeMarkdown } from "./safe-markdown";

const source = readFileSync(resolve(__dirname, "safe-markdown.tsx"), "utf-8");

function render(content: string, size?: "base" | "sm") {
  return renderToStaticMarkup(createElement(SafeMarkdown, { content, size }));
}

describe("isSafeHref", () => {
  it("blocks javascript: URIs", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
  });

  it("blocks data: URIs", () => {
    expect(isSafeHref("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("blocks vbscript: URIs", () => {
    expect(isSafeHref("vbscript:MsgBox('XSS')")).toBe(false);
  });

  it("blocks http URLs (only https allowed)", () => {
    expect(isSafeHref("http://example.com")).toBe(false);
  });

  it("allows https URLs", () => {
    expect(isSafeHref("https://weather.mukoko.com/harare")).toBe(true);
  });

  it("allows relative paths and anchors", () => {
    expect(isSafeHref("/harare")).toBe(true);
    expect(isSafeHref("#section")).toBe(true);
  });

  it("returns false for undefined and empty string", () => {
    expect(isSafeHref(undefined)).toBe(false);
    expect(isSafeHref("")).toBe(false);
  });
});

describe("SafeMarkdown rendering", () => {
  it("renders https links as external anchors with rel and target", () => {
    const html = render("[docs](https://example.com/docs)");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("does not render javascript: links as anchors (text kept, no href)", () => {
    const html = render("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a ");
    expect(html).toContain("click");
  });

  it("does not render data: links as anchors", () => {
    const html = render("[x](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain("data:text");
    expect(html).not.toContain("<a ");
  });

  it("does not render http: links as anchors", () => {
    const html = render("[plain](http://example.com)");
    expect(html).not.toContain('href="http://');
    expect(html).not.toContain("<a ");
  });

  it("applies the base prose chain by default and prose-sm for size sm", () => {
    const base = render("hello");
    expect(base).toContain("prose prose-base max-w-none");
    expect(base).toContain("prose-li:marker:text-text-tertiary");
    const sm = render("hello", "sm");
    expect(sm).toContain("prose prose-sm max-w-none");
    expect(sm).not.toContain("prose-base");
  });
});

describe("SafeMarkdown error isolation (source contract)", () => {
  it("wraps rendering in a boundary that falls back to the raw content", () => {
    expect(source).toContain("class MarkdownErrorBoundary");
    expect(source).toContain("static getDerivedStateFromError");
    expect(source).toContain("<MarkdownErrorBoundary fallback={content}>");
  });

  it("only allows https: (not http:) via the URL constructor", () => {
    expect(source).toContain('url.protocol === "https:"');
    expect(source).not.toContain('url.protocol === "http:"');
  });
});
