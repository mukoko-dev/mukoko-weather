/**
 * A small client renderer for tests, with no DOM library.
 *
 * This repo's tests run in plain Node (vitest `environment: "node"`) and have
 * no jsdom or Testing Library. The effects, state and click handlers of a hook
 * or a component do not run in a server render, so they were never tested.
 * This helper renders with the REAL `react-dom/client` (the same reconciler,
 * effects, StrictMode and event system the app uses) into a minimal stand-in
 * for the DOM, enough for hooks and for small components: elements, text,
 * attributes, a click, focus, a few geometry stubs and `querySelector` for
 * `tag[attr="value"]` selectors. It is not a browser: layout, CSS and real
 * events are not simulated, so what depends on them (a measured scroll, the
 * fold of a sheet) is checked with stubbed boxes or in the real-browser checks
 * in scripts/browser-check/.
 *
 * Not imported by the app. Use `mount` for a component and `renderHook` for a
 * hook; both come with `act`.
 */

import { act, createElement, StrictMode, type ReactElement } from "react";

type Listener = (event: unknown) => void;

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

const NO_BOX: Box = {
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  width: 0,
  height: 0,
};

export class FakeNode {
  nodeType = 1;
  nodeName = "";
  tagName = "";
  namespaceURI = "http://www.w3.org/1999/xhtml";
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, { fn: Listener; capture: boolean }[]>();
  nodeValue: string | null = null;
  style: Record<string, string> = {};
  /** What `getBoundingClientRect()` returns; set it in a test to give a node a size. */
  box: Box = NO_BOX;
  /** Where a scroller is scrolled to; `scrollTo` and `scrollBy` move it. */
  scrollLeft = 0;
  /** Every `scrollTo` and `scrollBy` call, for a test to read. */
  scrollCalls: unknown[] = [];

  constructor(doc: FakeDocument | null) {
    this.ownerDocument = doc ?? (this as unknown as FakeDocument);
  }

  /** `id` and `className` reflect to attributes, as in a browser. */
  get id(): string {
    return this.getAttribute("id") ?? "";
  }
  set id(value: string) {
    this.setAttribute("id", value);
  }
  get className(): string {
    return this.getAttribute("class") ?? "";
  }
  set className(value: string) {
    this.setAttribute("class", value);
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const p = this.parentNode;
    return p ? (p.childNodes[p.childNodes.indexOf(this) + 1] ?? null) : null;
  }
  get previousSibling(): FakeNode | null {
    const p = this.parentNode;
    return p ? (p.childNodes[p.childNodes.indexOf(this) - 1] ?? null) : null;
  }

  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null);
  }
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    if (ref) this.childNodes.splice(this.childNodes.indexOf(ref), 0, child);
    else this.childNodes.push(child);
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    // A browser moves focus to the page when the focused element is removed.
    const active = this.ownerDocument.activeElement;
    if (active && (active === child || child.contains(active)))
      this.ownerDocument.activeElement = null;
    return child;
  }
  contains(other: FakeNode | null): boolean {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  addEventListener(
    type: string,
    fn: Listener,
    options?: boolean | { capture?: boolean },
  ) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l.fn !== fn),
    );
  }

  get textContent(): string {
    return this.nodeType === 3
      ? (this.nodeValue ?? "")
      : this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.childNodes = [];
    if (value) this.appendChild(this.ownerDocument.createTextNode(value));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this)
      this.ownerDocument.activeElement = null;
  }

  getBoundingClientRect(): Box {
    return this.box;
  }
  scrollTo(options: { left?: number; behavior?: string }) {
    this.scrollCalls.push(options);
    if (options.left !== undefined) this.scrollLeft = options.left;
  }
  scrollBy(options: { left?: number; behavior?: string }) {
    this.scrollCalls.push(options);
    this.scrollLeft += options.left ?? 0;
  }
  scrollIntoView() {}

  /** Every element below this one, in document order. */
  descendants(): FakeNode[] {
    return this.childNodes.flatMap((c) => [c, ...c.descendants()]);
  }
  /** Elements for which `test` is true. */
  findAll(test: (node: FakeNode) => boolean): FakeNode[] {
    return this.descendants().filter((n) => n.nodeType === 1 && test(n));
  }
  /** The first element matching a space-separated list of `tag[attr="value"]` selectors. */
  querySelector(selector: string): FakeNode | null {
    const steps = selector.trim().split(/\s+/);
    const matches = (node: FakeNode, step: string): boolean => {
      const tag = /^[a-zA-Z][\w-]*/.exec(step)?.[0];
      if (tag && node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      for (const [, name, value] of step.matchAll(
        /\[([\w-]+)(?:="([^"]*)")?\]/g,
      )) {
        const actual = node.getAttribute(name);
        if (value === undefined ? actual === null : actual !== value)
          return false;
      }
      return true;
    };
    let scope: FakeNode[] = [this];
    for (const step of steps) {
      scope = scope
        .flatMap((n) => n.descendants())
        .filter((n) => n.nodeType === 1 && matches(n, step));
    }
    return scope[0] ?? null;
  }
}

export class FakeDocument extends FakeNode {
  activeElement: FakeNode | null = null;
  defaultView: unknown = null;
  body: FakeNode;

  constructor() {
    super(null);
    this.nodeType = 9;
    this.ownerDocument = this;
    this.body = new FakeNode(this);
    this.body.nodeName = this.body.tagName = "BODY";
    this.appendChild(this.body);
  }

  createElement(type: string): FakeNode {
    const node = new FakeNode(this);
    node.nodeName = node.tagName = type.toUpperCase();
    return node;
  }
  createElementNS(namespace: string, type: string): FakeNode {
    const node = this.createElement(type);
    node.namespaceURI = namespace;
    return node;
  }
  getElementById(id: string): FakeNode | null {
    return this.findAll((n) => n.getAttribute("id") === id)[0] ?? null;
  }
  createTextNode(value: string): FakeNode {
    const node = new FakeNode(this);
    node.nodeType = 3;
    node.nodeName = "#text";
    node.nodeValue = value;
    return node;
  }
}

const GLOBALS = [
  "window",
  "document",
  "getComputedStyle",
  "requestAnimationFrame",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

/** Installs the stand-in as `window` and `document`; returns the document and a restore function. */
function installDom(options: { localStorage?: unknown } = {}): {
  doc: FakeDocument;
  restore: () => void;
} {
  const g = globalThis as Record<string, unknown>;
  const saved = new Map<string, { had: boolean; value: unknown }>(
    GLOBALS.map((k) => [k, { had: k in g, value: g[k] }]),
  );
  const doc = new FakeDocument();
  const win = {
    document: doc,
    HTMLIFrameElement: class {},
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    getComputedStyle: () => ({
      paddingInlineStart: "0",
      paddingInlineEnd: "0",
    }),
    // Read at call time, so a test's fake timers apply.
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (id: Parameters<typeof clearInterval>[0]) =>
      clearInterval(id),
    localStorage: options.localStorage,
  };
  doc.defaultView = win;
  g.window = win;
  g.document = doc;
  g.getComputedStyle = win.getComputedStyle;
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  if (options.localStorage) g.localStorage = options.localStorage;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    doc,
    restore() {
      for (const [k, { had, value }] of saved) {
        if (had) g[k] = value;
        else delete g[k];
      }
    },
  };
}

export interface Mounted {
  container: FakeNode;
  doc: FakeDocument;
  /** Renders again (a prop change) inside `act`. */
  rerender: (element: ReactElement) => Promise<void>;
  /** A real React click on `node`: runs its `onClick` through React's event system. */
  click: (node: FakeNode) => Promise<void>;
  /** Elements below the container whose attributes include `attrs`. */
  find: (attrs: Record<string, string>) => FakeNode[];
  /** The first button whose text is `text`. */
  button: (text: string) => FakeNode | undefined;
  unmount: () => Promise<void>;
}

/** Renders `element` (in StrictMode when asked) with the real React DOM and waits for its effects. */
export async function mount(
  element: ReactElement,
  options: { strict?: boolean; localStorage?: unknown } = {},
): Promise<Mounted> {
  const { doc, restore } = installDom({ localStorage: options.localStorage });
  const { createRoot } = await import("react-dom/client");
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as never);
  const wrap = (el: ReactElement) =>
    options.strict ? createElement(StrictMode, null, el) : el;
  await act(async () => {
    root.render(wrap(element));
  });
  return {
    container,
    doc,
    async rerender(next) {
      await act(async () => {
        root.render(wrap(next));
      });
    },
    async click(node) {
      const event = {
        type: "click",
        target: node,
        bubbles: true,
        cancelable: true,
        defaultPrevented: false,
        timeStamp: 0,
        isTrusted: true,
        preventDefault() {},
        stopPropagation() {},
      };
      const handlers = container.listeners.get("click") ?? [];
      await act(async () => {
        // React listens on the root, for the capture phase and then the bubble phase.
        for (const { fn } of handlers.filter((h) => h.capture)) fn(event);
        for (const { fn } of handlers.filter((h) => !h.capture)) fn(event);
      });
    },
    find(attrs) {
      return container.findAll((n) =>
        Object.entries(attrs).every(([k, v]) => n.getAttribute(k) === v),
      );
    },
    button(text) {
      return container.findAll(
        (n) => n.tagName === "BUTTON" && n.textContent.trim() === text,
      )[0];
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      restore();
    },
  };
}

/**
 * Renders a hook and returns its latest value. `rerender(props)` calls it again
 * with new props; `strict` renders in StrictMode (effects run twice, as in
 * development).
 */
export async function renderHook<Result, Props = undefined>(
  hook: (props: Props) => Result,
  options: { initialProps?: Props; strict?: boolean } = {},
): Promise<{
  result: { current: Result };
  rerender: (props?: Props) => Promise<void>;
  unmount: () => Promise<void>;
  doc: FakeDocument;
}> {
  const result = { current: undefined as Result };
  function Probe({ props }: { props: Props }) {
    result.current = hook(props);
    return null;
  }
  const element = (props: Props) => createElement(Probe, { props });
  const mounted = await mount(element(options.initialProps as Props), {
    strict: options.strict,
  });
  let latest = options.initialProps as Props;
  return {
    result,
    doc: mounted.doc,
    async rerender(props) {
      if (props !== undefined) latest = props;
      await mounted.rerender(element(latest));
    },
    unmount: () => mounted.unmount(),
  };
}

export { act };
