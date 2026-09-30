// A copy-to-clipboard code snippet, shared by every step-by-step wizard
// (TutorialWizard.tsx, BotTutorialWizard.tsx) — each wizard page is
// nothing but copy-pasteable commands for the developer's own terminal,
// since this is a browser page and can't run anything on their machine
// itself.

import { useState } from "react";

import { Check, Copy } from "./Icons";

export function CodeBlock({ code }: { code: string }) {
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
    <div className="code-block">
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
