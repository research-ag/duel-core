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
        Open{" "}
        <a href="https://claude.ai/code" target="_blank" rel="noreferrer">
          claude.ai/code
        </a>{" "}
        in a browser (in the Claude desktop app: its <strong>Code</strong> tab;
        the chat home, with a <strong>Project</strong> selector under the
        message box, is not it). On a first visit it asks you to connect GitHub:
        allow it for the repository above. On the screen where you start a new
        session, click the first control in the row under the message box (the
        environment selector), then <strong>New environment</strong> at the
        bottom of its menu, or hover over <strong>Default</strong> under{" "}
        <strong>Cloud</strong> and click its settings icon. In the dialog:
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
        Then save the environment.
      </li>
      <li>
        Back on the new-session screen, with that environment selected, pick
        your repository in the same row and send the prompt from the next step.
        The session runs on Anthropic's servers, so you can follow it from a
        phone too.
      </li>
    </ol>
  );
}
