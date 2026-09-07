// A hand-rolled, purpose-built DOM stand-in for testing app.ts in Node
// (no `document` global there) — deliberately NOT a general-purpose DOM
// implementation. It only implements the exact surface app.ts touches:
// getElementById/createElement, addEventListener/dispatch,
// classList.add/remove, dataset, and innerHTML/textContent as plain
// string properties (no HTML parsing — screenEl.innerHTML is written by
// renderIfChanged() but never read back as structured markup by app.ts
// itself, only assigned and occasionally re-read as a plain string).
//
// Pulling in a real DOM implementation (e.g. jsdom) as a devDependency
// was considered and rejected: this package's whole ethos (see the root
// CLAUDE.md's rule 10) is staying dependency-free everywhere it can, and
// the actual DOM surface app.ts needs is small enough that a real
// implementation would mostly sit unused.

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
}

type Listener = (ev: unknown) => void;

export class FakeElement {
  dataset: Record<string, string> = {};
  disabled = false;
  hidden = false;
  textContent = "";
  className = "";
  innerHTML = "";
  isConnected = true;
  classList = new FakeClassList();
  children: FakeElement[] = [];
  listeners: Record<string, Listener[]> = {};
  private _sub: FakeElement | null = null;

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

  /// Always empty — app.ts only uses this to snapshot buttons already
  /// rendered into `innerHTML`, which this stub never parses. Callers
  /// that need button state instead construct a synthetic click event
  /// with a fake `target`/`closest()` — see makeButton() below.
  querySelectorAll(_sel: string): FakeElement[] {
    return [];
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
