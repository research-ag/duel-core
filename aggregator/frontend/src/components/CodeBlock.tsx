// A copy-to-clipboard code snippet, shared by every step-by-step wizard
// (TutorialWizard.tsx, BotTutorialWizard.tsx, ...) — each wizard page is
// nothing but copy-pasteable commands for the developer's own terminal,
// since this is a browser page and can't run anything on their machine
// itself. `CopyId` is the inline form, for a principal.

import { useState } from "react";

import { Check, Copy } from "./Icons";

function useCopy(text: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — nothing else to do.
    }
  }

  return [copied, () => void copy()];
}

/// `wrap` is for prose (a prompt): long lines fold instead of scrolling.
export function CodeBlock({ code, wrap }: { code: string; wrap?: boolean }) {
  const [copied, copy] = useCopy(code);

  return (
    <div className={`code-block${wrap ? " wrap" : ""}`}>
      <button
        type="button"
        className={`copy${copied ? " done" : ""}`}
        onClick={copy}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{code}</pre>
    </div>
  );
}

export function CopyId({ id }: { id: string }) {
  const [copied, copy] = useCopy(id);

  return (
    <span className="copy-id">
      <span className="mono">{id}</span>
      <button
        type="button"
        className={`copy-id-btn${copied ? " done" : ""}`}
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy"}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </span>
  );
}
