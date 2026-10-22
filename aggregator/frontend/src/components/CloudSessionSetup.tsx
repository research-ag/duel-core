// The once-per-project setup of a Claude Code cloud session that deploys
// through hosty.live, shared by every guide (cloudSession.ts has the
// texts).

import {
  MCP_JSON,
  NETWORK_DOMAINS,
  SECRET_HOST,
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
        exactly this content. It tells the session where hosty.live is; your
        token never goes into the repository:
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
            <strong>Network secrets</strong> → <strong>Add secret</strong>:
            type <strong>Bearer</strong>, name <code>hosty.live</code>, allowed
            website
            <CodeBlock code={SECRET_HOST} />
            and your <code>hl_</code> token as the value of the{" "}
            <code>Authorization</code> header row (prefix <code>Bearer</code>).
            Claude's servers add it to every request to hosty.live, so the
            session itself never sees your token. On a Team plan without an
            organization admin role the form is shorter: host{" "}
            <code>{SECRET_HOST}</code>, secret type <strong>Token</strong>, your
            token as the value. Then make sure it arrives as a Bearer token: the
            session's first <code>hosty_whoami</code> must answer, not fail with
            401.
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
