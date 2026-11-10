// A copy-to-clipboard code snippet, shared by every step-by-step wizard
// (TutorialWizard.tsx, BotTutorialWizard.tsx, ...) — each wizard page is
// nothing but copy-pasteable commands for the developer's own terminal,
// since this is a browser page and can't run anything on their machine
// itself. `CopyId` is the inline form, for a principal.

import { useRef, useState } from "react";
import type { RefObject } from "react";

import { Check, Copy } from "./Icons";

type CopyState = "idle" | "done" | "failed";

/// Without clipboard access (e.g. an insecure context) the copy fails,
/// and the text in `target` is selected for the user to copy by hand.
function useCopy(
  text: string,
  target: RefObject<HTMLElement | null>
): [CopyState, () => void] {
  const [state, setState] = useState<CopyState>("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      if (target.current)
        window.getSelection()?.selectAllChildren(target.current);
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1500);
  }

  return [state, () => void copy()];
}

const LABEL: Record<CopyState, string> = {
  idle: "Copy",
  done: "Copied",
  failed: "Copy failed",
};

/// `wrap` is for prose (a prompt): long lines fold instead of scrolling.
export function CodeBlock({ code, wrap }: { code: string; wrap?: boolean }) {
  const pre = useRef<HTMLPreElement>(null);
  const [state, copy] = useCopy(code, pre);

  return (
    <div className={`code-block${wrap ? " wrap" : ""}`}>
      <button type="button" className={`copy ${state}`} onClick={copy}>
        {state === "done" ? <Check /> : <Copy />}
        {LABEL[state]}
      </button>
      <pre ref={pre}>{code}</pre>
    </div>
  );
}

export function CopyId({ id }: { id: string }) {
  const text = useRef<HTMLSpanElement>(null);
  const [state, copy] = useCopy(id, text);

  return (
    <span className="copy-id">
      <span className="mono" ref={text}>
        {id}
      </span>
      <button
        type="button"
        className={`copy-id-btn ${state}`}
        onClick={copy}
        aria-label={LABEL[state]}
        title={LABEL[state]}
      >
        {state === "done" ? <Check /> : <Copy />}
      </button>
    </span>
  );
}
