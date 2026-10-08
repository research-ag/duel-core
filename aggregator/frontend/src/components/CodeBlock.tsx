// A copy-to-clipboard code snippet, shared by every step-by-step wizard
// (TutorialWizard.tsx, BotTutorialWizard.tsx) — each wizard page is
// nothing but copy-pasteable commands for the developer's own terminal,
// since this is a browser page and can't run anything on their machine
// itself.

import { useState } from "react";

import { Check, Copy } from "./Icons";

/// `wrap` is for prose (a prompt): long lines fold instead of scrolling.
export function CodeBlock({ code, wrap }: { code: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — nothing else to do.
    }
  }

  return (
    <div className={`code-block${wrap ? " wrap" : ""}`}>
      <button
        type="button"
        className={`copy${copied ? " done" : ""}`}
        onClick={() => void copy()}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{code}</pre>
    </div>
  );
}
