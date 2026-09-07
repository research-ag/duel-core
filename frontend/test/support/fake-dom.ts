// A hand-rolled, purpose-built DOM stand-in for testing app.ts in Node
// (no `document` global there) — deliberately NOT a general-purpose DOM
// implementation. It only implements the exact surface app.ts touches:
// getElementById/createElement, addEventListener/dispatch,
// classList.add/remove, dataset, and innerHTML/textContent as plain
// string properties.
//
// Pulling in a real DOM implementation (e.g. jsdom) as a devDependency
// was considered and rejected: this package's whole ethos (see the root
// CLAUDE.md's rule 10) is staying dependency-free everywhere it can, and
// the actual DOM surface app.ts needs is small enough that a real
// implementation would mostly sit unused.
//
// One narrow exception: assigning `innerHTML` DOES parse out `<button
// ...>` tags into real child FakeElements (see `parseButtons` below),
// just enough that `querySelectorAll("button")` — the one selector
// app.ts's applyLoadingState() ever asks for — can answer honestly. This
// exists specifically so a test can reproduce a re-render REPLACING a
// button mid-flight (an unrelated push tick redrawing the screen while
// this tab's own call is still pending) and assert on the freshly
// created node, the way a real browser's own querySelectorAll would
// hand back a new node too — not just on the exact object a test built
// by hand with makeButton(). It is still not a general HTML parser: only
// `<button>` tags and their attributes are recognized, and only
// `class`/`disabled`/`data-*` are read off them.

const BUTTON_TAG_RE = /<button\b([^>]*)>/gi;
const ATTR_RE = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

function parseButtons(html: string): FakeElement[] {
  const buttons: FakeElement[] = [];
  BUTTON_TAG_RE.lastIndex = 0;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = BUTTON_TAG_RE.exec(html))) {
    const el = new FakeElement();
    el.tagName = "button";
    ATTR_RE.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = ATTR_RE.exec(tagMatch[1]))) {
      const [, name, dq, sq] = attrMatch;
      const value = dq ?? sq ?? "";
      if (name === "disabled") el.disabled = true;
      else if (name === "class") el.className = value;
      else if (name.startsWith("data-")) el.dataset[name.slice(5)] = value;
    }
    buttons.push(el);
  }
  return buttons;
}

export class FakeClassList {
  private set = new Set<string>();
  add(...names: string[]): void {
    for (const n of names) this.set.add(n);
  }
  remove(...names: string[]): void {
    for (const n of names) this.set.delete(n);
  }
  contains(name: string): boolean {
    return this.set.has(name);
  }
  toggle(name: string, force?: boolean): void {
    const on = force ?? !this.set.has(name);
    if (on) this.set.add(name);
    else this.set.delete(name);
  }
}

type Listener = (ev: unknown) => void;

export class FakeElement {
  dataset: Record<string, string> = {};
  disabled = false;
  hidden = false;
  textContent = "";
  className = "";
  tagName = "div";
  isConnected = true;
  classList = new FakeClassList();
  children: FakeElement[] = [];
  listeners: Record<string, Listener[]> = {};
  private _sub: FakeElement | null = null;
  private _innerHTML = "";

  get innerHTML(): string {
    return this._innerHTML;
  }

  /// Replaces `children` with freshly parsed `<button>` stand-ins (see
  /// parseButtons() above) — same as a real browser discarding and
  /// recreating every descendant node on an innerHTML assignment.
  set innerHTML(html: string) {
    this._innerHTML = html;
    this.children = parseButtons(html);
  }

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }

  /// Not a real DOM method — the test's own way of firing a listener
  /// registered via addEventListener above.
  dispatch(type: string, ev: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }

  appendChild<T extends FakeElement>(child: T): T {
    this.children.push(child);
    return child;
  }

  /// Always returns the same one sub-element regardless of selector —
  /// enough for app.ts's single `confirmOverlay.querySelector(".duel-
  /// confirm-msg")` call; this stub never parses `innerHTML` into real
  /// nodes, so it can't answer a selector honestly.
  querySelector(_sel: string): FakeElement {
    return (this._sub ??= new FakeElement());
  }

  /// Only "button" is recognized (the one selector app.ts ever passes to
  /// applyLoadingState()) — answered from the children the last
  /// `innerHTML` assignment parsed out (see parseButtons() above). Any
  /// other selector returns empty, same as before this existed.
  querySelectorAll(sel: string): FakeElement[] {
    if (sel !== "button") return [];
    return this.children.filter((c) => c.tagName === "button");
  }

  closest(_sel: string): FakeElement {
    return this;
  }
}

/// A minimal stand-in for a clicked `<button>` — has just enough surface
/// (`closest()` returning itself, `dataset`, `disabled`) for app.ts's
/// click-delegation handler to read it as the event's `target`.
export function makeButton(dataset: Record<string, string>): FakeElement {
  const b = new FakeElement();
  b.tagName = "button";
  b.dataset = dataset;
  return b;
}

export interface FakeDocument {
  body: FakeElement;
  cookie: string;
  visibilityState: string;
  getElementById(id: string): FakeElement | null;
  createElement(tag: string): FakeElement;
  addEventListener(type: string, fn: Listener): void;
  removeEventListener(type: string, fn: Listener): void;
}

/// Builds a fake `document` pre-seeded with `elements` (keyed by id, as
/// `document.getElementById` would find them).
export function makeFakeDocument(elements: Record<string, FakeElement> = {}): FakeDocument {
  const body = new FakeElement();
  const listeners: Record<string, Listener[]> = {};
  return {
    body,
    cookie: "",
    visibilityState: "visible",
    getElementById: (id) => elements[id] ?? null,
    createElement: () => new FakeElement(),
    addEventListener: (type, fn) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type, fn) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
  };
}
