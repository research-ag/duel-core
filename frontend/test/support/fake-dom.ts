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
// ...>` tags, any element carrying a `data-wait-base` attribute, and
// `<input ...>` tags into real child FakeElements (see
// `parseTaggedElements` below), just enough that `querySelectorAll
// ("button")`, `querySelectorAll("[data-wait-base]")`, and the two
// literal `<input>` selectors app.ts's create-form state capture/restore
// asks for (see FakeElement.querySelector below) can all answer
// honestly. This exists specifically so a test can reproduce a
// re-render REPLACING an element mid-flight (an unrelated push tick
// redrawing the screen while this tab's own call is still pending, a
// fresh browsing-list render re-baselining the wait ticker, or the
// create-table form's own live input surviving that same redraw) and
// assert on the freshly created node, the way a real browser's own
// querySelector(All) would hand back a new node too — not just on the
// exact object a test built by hand with makeButton(). It is still not
// a general HTML parser: only `<button>`/`<input>` tags and elements
// with `data-wait-base` are recognized, and only a handful of attributes
// are read off them (`class`/`disabled`/`data-*` for any tag; `id`/
// `name`/`value`/`checked`/`hidden` additionally for `<input>`).

const TAGGED_EL_RE = /<(button|span|input)\b([^>]*)>/gi;
const ATTR_RE = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

function parseTaggedElements(html: string): FakeElement[] {
  const found: FakeElement[] = [];
  TAGGED_EL_RE.lastIndex = 0;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = TAGGED_EL_RE.exec(html))) {
    const [, tagName, attrsSrc] = tagMatch;
    const el = new FakeElement();
    el.tagName = tagName.toLowerCase();
    ATTR_RE.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = ATTR_RE.exec(attrsSrc))) {
      const [, name, dq, sq] = attrMatch;
      const value = dq ?? sq ?? "";
      if (name === "disabled") el.disabled = true;
      else if (name === "hidden") el.hidden = true;
      else if (name === "checked") el.checked = true;
      else if (name === "class") el.className = value;
      else if (name === "id") el.id = value;
      else if (name === "name") el.name = value;
      else if (name === "value") el.value = value;
      else if (name.startsWith("data-")) {
        // Mirror a real browser's `dataset` API: `data-join-table-id`
        // becomes `dataset.joinTableId`, not the literal hyphenated
        // string — app.ts's click handler (and makeTableWaitTicker) read
        // the camelCase form.
        const camelKey = name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        el.dataset[camelKey] = value;
      }
    }
    // A plain `<span>` with no `data-wait-base` is just markup this file
    // doesn't need to represent (e.g. `.muted`/`.table-id` labels) — only
    // `<button>`s, wait-ticker spans, and `<input>`s are real "elements"
    // here.
    if (el.tagName === "span" && !("waitBase" in el.dataset)) continue;
    found.push(el);
  }
  return found;
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
  checked = false;
  textContent = "";
  className = "";
  tagName = "div";
  id = "";
  name = "";
  value = "";
  isConnected = true;
  classList = new FakeClassList();
  children: FakeElement[] = [];
  listeners: Record<string, Listener[]> = {};
  private _sub: FakeElement | null = null;
  private _innerHTML = "";

  get innerHTML(): string {
    return this._innerHTML;
  }

  /// Replaces `children` with freshly parsed stand-ins (see
  /// parseTaggedElements() above) — same as a real browser discarding and
  /// recreating every descendant node on an innerHTML assignment.
  set innerHTML(html: string) {
    this._innerHTML = html;
    this.children = parseTaggedElements(html);
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

  /// Recognizes the `<input name="table-visibility">` selectors app.ts
  /// passes — `:checked` (captureCreateFormState) and `[value="..."]`
  /// (restoreCreateFormState, and the pre-existing readCreateVisibility)
  /// — answered from the children the last `innerHTML` assignment parsed
  /// out (see parseTaggedElements() above), same idea as
  /// querySelectorAll below. Genuinely returns `null` on no match, like
  /// a real DOM, since app.ts's own null-checks on these two selectors
  /// are exactly what this file exists to exercise. Any OTHER selector
  /// falls back to the same always-same-stub element as before these
  /// existed (enough for `confirmOverlay.querySelector(".duel-confirm-
  /// msg")`, which this file still never parses `innerHTML` for
  /// honestly).
  querySelector(sel: string): FakeElement | null {
    if (sel === 'input[name="table-visibility"]:checked') {
      return this.children.find((c) => c.tagName === "input" && c.name === "table-visibility" && c.checked) ?? null;
    }
    const valueSel = /^input\[name="table-visibility"\]\[value="([^"]*)"\]$/.exec(sel);
    if (valueSel) {
      return (
        this.children.find(
          (c) => c.tagName === "input" && c.name === "table-visibility" && c.value === valueSel[1],
        ) ?? null
      );
    }
    return (this._sub ??= new FakeElement());
  }

  /// Only "button" and "[data-wait-base]" are recognized (the two
  /// selectors app.ts ever passes, to applyLoadingState() and
  /// makeTableWaitTicker() respectively) — answered from the children the
  /// last `innerHTML` assignment parsed out (see parseTaggedElements()
  /// above). Any other selector returns empty, same as before this
  /// existed.
  querySelectorAll(sel: string): FakeElement[] {
    if (sel === "button") return this.children.filter((c) => c.tagName === "button");
    if (sel === "[data-wait-base]") return this.children.filter((c) => "waitBase" in c.dataset);
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
  // `getElementById` falls back to whatever `elements.screen`'s last
  // `innerHTML` assignment parsed out (see parseTaggedElements() above)
  // once the pre-seeded map itself has no entry — app.ts's `$()` looks
  // up form fields (create-code, joinbycode-id, joinbycode-code) that
  // only ever exist there, rendered dynamically by render.ts, never
  // pre-seeded like sid/new-sid/error/screen themselves.
  const getElementById = (id: string): FakeElement | null =>
    elements[id] ?? elements.screen?.children.find((c) => c.id === id) ?? null;
  return {
    body,
    cookie: "",
    visibilityState: "visible",
    getElementById,
    createElement: () => new FakeElement(),
    addEventListener: (type, fn) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type, fn) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
  };
}
