/**
 * TypingDots — shared "assistant is thinking" indicator.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TypingDots } from "./typing-dots";

const source = readFileSync(resolve(__dirname, "typing-dots.tsx"), "utf-8");

describe("TypingDots render", () => {
  it("is a labelled status region", () => {
    const html = renderToStaticMarkup(
      createElement(TypingDots, { label: "Thinking..." }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Thinking..."');
  });

  it("renders three decorative dots", () => {
    const html = renderToStaticMarkup(createElement(TypingDots, {}));
    expect(html.match(/aria-hidden="true"/g)?.length).toBe(3);
  });
});

describe("TypingDots contract", () => {
  it("gates the bounce behind motion-safe (reduced-motion respected)", () => {
    expect(source).toContain("motion-safe:animate-bounce");
    expect(source).not.toMatch(/(^|\s)animate-bounce/);
  });

  it("uses the text-tertiary token for the dots", () => {
    expect(source).toContain("bg-text-tertiary");
  });
});
