/**
 * ChatComposer — shared composer used by the AI follow-up chat and the
 * Shamwari Explorer. Behavioural render checks plus source contract checks
 * for the keyboard and layout rules.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatComposer } from "./chat-composer";

const source = readFileSync(resolve(__dirname, "chat-composer.tsx"), "utf-8");

function render(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ChatComposer, {
      value: "",
      onChange: () => {},
      onSend: () => {},
      ariaLabel: "Test input",
      ...props,
    }),
  );
}

describe("ChatComposer render", () => {
  it("renders a labelled textarea and a send button", () => {
    const html = render();
    expect(html).toContain("<textarea");
    expect(html).toContain('aria-label="Test input"');
    expect(html).toContain('aria-label="Send message"');
  });

  it("disables the send button when the value is blank", () => {
    expect(render({ value: "   " })).toMatch(/<button[^>]*disabled=""/);
  });

  it("enables the send button when there is text", () => {
    const html = render({ value: "hello" });
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
  });

  it("uses the radius-card token rather than rounded-2xl", () => {
    const html = render();
    expect(html).toContain("rounded-[var(--radius-card)]");
    expect(html).not.toContain("rounded-2xl");
  });

  it("uses the surface prop for the card background", () => {
    expect(render({ surface: "card" })).toContain("bg-surface-card");
    expect(render()).toContain("bg-surface-base");
  });
});

describe("ChatComposer behaviour (source contract)", () => {
  it("sends on Enter and inserts a newline on Shift+Enter", () => {
    expect(source).toContain('e.key === "Enter" && !e.shiftKey');
    expect(source).toContain("e.preventDefault();");
  });

  it("submits through a form and prevents the default submit", () => {
    expect(source).toContain("onSubmit={handleSubmit}");
    expect(source).toContain("e.preventDefault();\n    onSend();");
  });

  it("auto-grows the textarea up to maxHeight and re-measures on value change", () => {
    expect(source).toContain("Math.min(el.scrollHeight, maxHeight)");
    expect(source).toContain("}, [value, maxHeight, ref]);");
  });

  it("uses the shared icon-lg round button with an aria-hidden ArrowUp icon", () => {
    expect(source).toContain('size="icon-lg"');
    expect(source).toContain('import { ArrowUp } from "lucide-react"');
    expect(source).toContain('<ArrowUp size={18} aria-hidden="true" />');
  });

  it("uses no hardcoded colours", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}[^)]/);
    expect(source).not.toContain("style={{");
  });
});
