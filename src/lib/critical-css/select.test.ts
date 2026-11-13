import { describe, expect, it } from "vitest";
import { selectCritical } from "../../../scripts/critical-css/select.mjs";

// The rule that decides what is critical (issue #551): a style rule is kept
// when SOME selector in its list could match an element of the first screen,
// judged by names alone. These tests run it on small stylesheets.

const vocabulary = {
  tags: ["html", "body", "div", "button"],
  classes: ["flex", "p-4", "dark:bg-black", "min-[480px]:pl-2", "hero"],
  ids: ["main-content"],
  attributes: ["data-theme", "data-theme=dark", "role", "role=banner"],
};

const pick = (css: string) => selectCritical(css, vocabulary).css;

describe("selectCritical keeps what the first screen can match", () => {
  it("keeps a rule whose classes are all in the DOM, and drops one that has an absent class", () => {
    const css = pick(
      ".flex{display:flex}.p-4{padding:1rem}.absent{color:red}.flex.absent{color:blue}",
    );
    expect(css).toContain(".flex{display:flex}");
    expect(css).toContain(".p-4{padding:1rem}");
    expect(css).not.toContain(".absent{");
    expect(css).not.toContain("blue");
  });

  it("keeps a rule when any selector of its list can match", () => {
    const css = pick(".absent,.flex{display:flex}");
    expect(css).toContain("display:flex");
  });

  it("judges every compound of a combinator, not the relation between them", () => {
    expect(pick(".flex .hero{margin:0}")).toContain("margin:0");
    expect(pick(".flex .absent{margin:0}")).not.toContain("margin");
  });

  it("keeps state and pseudo-element rules of elements that are there", () => {
    const css = pick(
      ".p-4:hover{color:red}.flex::before{content:''}.absent:hover{color:blue}",
    );
    expect(css).toContain(".p-4:hover");
    expect(css).toMatch(/\.flex:{1,2}before/);
    expect(css).not.toContain("blue");
  });

  it("matches tags and ids against the DOM's", () => {
    const css = pick(
      "body{margin:0}table{border:0}#main-content{outline:0}#other{outline:1px}",
    );
    expect(css).toContain("body{margin:0}");
    expect(css).not.toContain("table");
    expect(css).toContain("#main-content");
    expect(css).not.toContain("#other");
  });

  it("matches an attribute by name, and by value for `=`", () => {
    const css = pick(
      '[data-theme="dark"] .flex{color:white}[data-theme="light"] .flex{color:black}[role]{x:1}[aria-hidden]{y:2}',
    );
    expect(css).toContain("#fff");
    expect(css).not.toContain("#000");
    expect(css).toContain("x:1");
    expect(css).not.toContain("y:2");
  });

  it("looks inside :is() and :where() (the dark variant) for what must be there", () => {
    const css = pick(
      '.dark\\:bg-black:is([data-theme="dark"] *){background:black}.flex:is([data-theme="night"] *){background:blue}',
    );
    expect(css).toContain("background:#000");
    expect(css).not.toContain("blue");
  });

  it("keeps media, supports and layer blocks only when something inside is kept", () => {
    const css = pick(
      "@layer base,utilities;@layer utilities{.flex{display:flex}.absent{color:red}}@media (min-width:480px){.min-\\[480px\\]\\:pl-2{padding-left:.5rem}.absent{color:red}}@media (min-width:900px){.absent{color:red}}@supports (display:grid){.absent{color:red}}",
    );
    expect(css).toContain("@layer base");
    expect(css).toContain("@layer utilities{");
    expect(css).toContain("display:flex");
    // a media condition is not judged: a phone's subset holds the wide rule
    expect(css).toContain("padding-left");
    expect(css).not.toContain("900px");
    expect(css).not.toContain("@supports");
    expect(css).not.toContain("{}");
    expect(css).not.toContain("red");
  });

  it("keeps @property and @font-face, which are not selected by an element", () => {
    const css = pick(
      "@property --tw-x{syntax:'*';inherits:false}@font-face{font-family:F;src:url(/f.woff2)}",
    );
    expect(css).toContain("@property --tw-x");
    expect(css).toContain("@font-face");
  });

  it("keeps a keyframes set a kept rule names, and only that one", () => {
    const css = pick(
      "@keyframes spin{to{transform:rotate(1turn)}}@keyframes unused{to{opacity:0}}.flex{animation:spin 1s linear infinite}.absent{animation:unused 1s}",
    );
    expect(css).toContain("@keyframes spin");
    expect(css).not.toContain("unused");
  });

  it("counts the rules it kept and dropped", () => {
    const { rules } = selectCritical(
      ".flex{a:1}.absent{b:2}.p-4{c:3}",
      vocabulary,
    );
    expect(rules).toEqual({ kept: 2, dropped: 1 });
  });
});
