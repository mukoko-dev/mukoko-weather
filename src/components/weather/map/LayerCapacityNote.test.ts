/**
 * LayerCapacityNote (#542): the line in the map sheet that says a live layer is
 * busy and a working one is showing instead. Rendered for real: the markup with
 * react-dom/server (like MapPreview's test), and the button with the real React
 * DOM (src/lib/test-render.ts) for what only a click or a focus can show.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { mount } from "@/lib/test-render";
import {
  LayerCapacityNote,
  LayerCapacityStatus,
  type RetryStatus,
} from "./LayerCapacityNote";

type NoteProps = Parameters<typeof LayerCapacityNote>[0];

function noteProps(patch: Partial<NoteProps> = {}): NoteProps {
  return {
    layerId: "precipitationIntensity",
    fallbackLabel: "Satellite",
    status: "idle",
    onRetry: () => {},
    ...patch,
  };
}

function render(patch: Partial<NoteProps> = {}): string {
  return renderToStaticMarkup(
    createElement(LayerCapacityNote, noteProps(patch)),
  );
}

describe("LayerCapacityNote: the words", () => {
  it("says plainly that live rain is busy and that satellite is showing", () => {
    expect(render()).toContain(
      "Live rain radar is busy right now. Showing satellite instead.",
    );
  });

  it("names the layer the person chose", () => {
    expect(render({ layerId: "temperature" })).toContain(
      "Live temperature map is busy right now.",
    );
    expect(render({ layerId: "windSpeed" })).toContain("Live wind map is busy");
    expect(render({ layerId: "cloudCover" })).toContain(
      "Live cloud map is busy",
    );
  });

  it("blames no one and shows no code", () => {
    const text = render().replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/error|failed|quota|\b429\b|\b503\b|tomorrow/i);
  });

  it("is plain content: the live region that announces it is the page's, so it is not read twice", () => {
    const html = render();
    expect(html).not.toContain("role=");
    expect(html).not.toContain("aria-live");
  });
});

describe("LayerCapacityNote: the button", () => {
  const button = (html: string) => html.match(/<button[^>]*>/)?.[0] ?? "";

  it("offers one tap to try again, named for the layer, with the visible words whole inside the name", () => {
    const html = render();
    expect(button(html)).toContain('type="button"');
    expect(button(html)).toContain('aria-label="Try again: live rain radar"');
    expect(button(html)).not.toContain("aria-disabled=");
    expect(html).toContain(">Try again</button>");
  });

  it("says 'Checking…' only while its one request is out, and is aria-disabled, not disabled", () => {
    const html = render({ status: "checking" });
    expect(html).toContain(">Checking…</button>");
    expect(button(html)).toContain('aria-disabled="true"');
    expect(button(html)).toContain('aria-busy="true"');
    // `disabled` would drop keyboard focus.
    expect(button(html)).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("says 'Checked a moment ago' when the answer came from memory, not 'Checking…'", () => {
    const html = render({ status: "recent" });
    expect(html).toContain(">Checked a moment ago</button>");
    expect(html).not.toContain("Checking");
    expect(button(html)).toContain('aria-disabled="true"');
  });

  it("uses Mzizi tokens and the pill control class, not hand-rolled sizes or colours", () => {
    const html = render();
    // .impala-sm is the outline pill with the 49 px minimum height.
    expect(html).toContain("impala-sm");
    expect(html).toContain("gap-[var(--gap-floor)]");
    expect(html).toContain("text-text-primary");
    expect(html).not.toMatch(/\d+px/);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toContain("style=");
  });
});

describe("LayerCapacityNote: using it", () => {
  it("a tap calls onRetry once when idle, and nothing while checking or just checked", async () => {
    const onRetry = vi.fn();
    const m = await mount(
      createElement(LayerCapacityNote, noteProps({ onRetry })),
    );
    await m.click(m.button("Try again")!);
    expect(onRetry).toHaveBeenCalledTimes(1);
    for (const status of ["checking", "recent"] as RetryStatus[]) {
      await m.rerender(
        createElement(LayerCapacityNote, noteProps({ onRetry, status })),
      );
      await m.click(m.container.findAll((n) => n.tagName === "BUTTON")[0]);
    }
    expect(onRetry).toHaveBeenCalledTimes(1);
    await m.unmount();
  });

  it("keeps keyboard focus on the button through 'Checking…' and back (it is the same element)", async () => {
    const m = await mount(createElement(LayerCapacityNote, noteProps()));
    const [btn] = m.container.findAll((n) => n.tagName === "BUTTON");
    btn.focus();
    await m.rerender(
      createElement(LayerCapacityNote, noteProps({ status: "checking" })),
    );
    const [during] = m.container.findAll((n) => n.tagName === "BUTTON");
    expect(during).toBe(btn);
    expect(m.doc.activeElement).toBe(btn);
    await m.rerender(createElement(LayerCapacityNote, noteProps()));
    expect(m.doc.activeElement).toBe(btn);
    await m.unmount();
  });
});

describe("LayerCapacityStatus", () => {
  const status = (state: {
    busy: boolean;
    held: boolean;
    checking: boolean;
    recent?: boolean;
  }) =>
    renderToStaticMarkup(
      createElement(LayerCapacityStatus, {
        layerId: "precipitationIntensity",
        fallbackLabel: "Satellite",
        state,
        recent: state.recent ?? false,
        onRetry: () => {},
      }),
    );

  it("shows the note, with the right button words, while the fallback is on screen", () => {
    expect(status({ busy: true, held: false, checking: false })).toContain(
      ">Try again</button>",
    );
    expect(status({ busy: true, held: false, checking: true })).toContain(
      ">Checking…</button>",
    );
    expect(
      status({ busy: true, held: false, checking: false, recent: true }),
    ).toContain(">Checked a moment ago</button>");
  });

  it("says it is checking while the overlay is held and a request is out, instead of a silent empty map", () => {
    const html = status({ busy: false, held: true, checking: true });
    expect(html).toContain("Checking live rain radar…");
    expect(html).not.toContain("<button");
  });

  it("says nothing before the request goes out, or when nothing is wrong", () => {
    expect(status({ busy: false, held: true, checking: false })).toBe("");
    expect(status({ busy: false, held: false, checking: false })).toBe("");
  });
});
