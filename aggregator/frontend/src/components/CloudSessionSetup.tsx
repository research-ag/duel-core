// The once-per-project setup of a Claude Code cloud session that deploys
// through hosty.live, shared by every guide (cloudSession.ts has the
// texts).

import {
  ENV_VARS,
  MCP_JSON,
  NETWORK_DOMAINS,
  SETUP_SCRIPT,
} from "../cloudSession";
import { CodeBlock } from "./CodeBlock";

export function HostyAccountSteps() {
  return (
    <ol className="tutorial-list">
      <li>
        Sign in at{" "}
        <a href="https://hosty.live/" target="_blank" rel="noreferrer">
          hosty.live
        </a>{" "}
        with Internet Identity (a passkey; no password, no email).
      </li>
      <li>
        <strong>Settings</strong> → <strong>AI agent access</strong> → create
        a token. It starts with <code>hl_</code> and is shown once: keep it
        for the next step. It is a password to your canisters; never paste it
        into a chat.
      </li>
      <li>
        <strong>Cycles</strong> → <strong>Deposit using Cycle Express</strong>{" "}
        tops up your balance by card. At the time of writing a page costs
        0.84 TC (about a dollar), a game's backend or a bot 1.5 TC.
      </li>
    </ol>
  );
}

export function CloudSessionSetup() {
  return (
    <ol className="tutorial-list">
      <li>
        Create a repository on{" "}
        <a href="https://github.com/new" target="_blank" rel="noreferrer">
          GitHub
        </a>{" "}
        (empty is fine). Add one file at its root (<strong>Add file</strong> →{" "}
        <strong>Create new file</strong>) named <code>.mcp.json</code>, with
        this content. It names your token without holding it:
        <CodeBlock code={MCP_JSON} />
      </li>
      <li>
        At{" "}
        <a href="https://claude.ai/code" target="_blank" rel="noreferrer">
          claude.ai/code
        </a>
        , create an environment (or edit the default one):
        <ul>
          <li>
            <strong>Environment variables</strong>, with your token in place
            of <code>hl_...</code>:
            <CodeBlock code={ENV_VARS} />
          </li>
          <li>
            <strong>Network access</strong>: <strong>Custom</strong>, with
            “Also include default list” on, and these domains:
            <CodeBlock code={NETWORK_DOMAINS} />
          </li>
          <li>
            <strong>Setup script</strong>:
            <CodeBlock code={SETUP_SCRIPT} />
          </li>
        </ul>
      </li>
      <li>
        Start a session on that repository with that environment. It runs on
        Anthropic's servers, so it works from a phone too.
      </li>
    </ol>
  );
}
