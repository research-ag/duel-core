// The setup steps the guides share (cloudSession.ts has the texts): the
// hosty.live connector, a Claude Code cloud session or an agent on the
// computer, the API token way for a plan without connectors, and the
// cycles each way pays for going live with.

import {
  CLI_CONNECT,
  CONNECTOR_URL,
  CONNECTORS_PAGE,
  MCP_JSON,
  NETWORK_DOMAINS,
  SECRET_HOST,
  SETUP_SCRIPT,
} from "../cloudSession";
import { CodeBlock } from "./CodeBlock";

const HOSTY = (
  <a href="https://hosty.live/" target="_blank" rel="noreferrer">
    hosty.live
  </a>
);

/// The whole hosty.live setup: the connector once, then where the agent
/// runs.
export function HostySetup() {
  return (
    <>
      <p>
        <strong>Once: connect Claude to hosty.live.</strong>
      </p>
      <ConnectorSteps />
      <p>
        <strong>Then pick where the AI works.</strong> Simplest is a{" "}
        <strong>cloud session</strong>: Claude Code runs on Anthropic's servers,
        so you can send the prompt, close your laptop and come back later.
        Nothing it serves can be opened from your browser, so every look at your
        work is online, on hosty.live.
      </p>
      <CloudSessionSetup />
      <p>
        <strong>Or on your computer</strong>, in Claude Code or another AI
        coding tool:
      </p>
      <LocalAgentSetup />
      <TokenSetup />
    </>
  );
}

export function ConnectorSteps() {
  return (
    <ol className="tutorial-list">
      <li>
        Open{" "}
        <a href={CONNECTORS_PAGE} target="_blank" rel="noreferrer">
          Claude's connector settings
        </a>{" "}
        and click <strong>Add custom connector</strong> (the labels are as at
        the time of writing). Paste this address:
        <CodeBlock code={CONNECTOR_URL} />
      </li>
      <li>
        {HOSTY} opens. Sign in with Internet Identity (a passkey; no password,
        no email) and approve. Once per Claude account: claude.ai, its cloud
        sessions and Claude Code on your computer then all have hosty.live's
        tools.
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
        for your work (tick <strong>Add a README file</strong>, so it is not
        empty).
      </li>
      <li>
        Open{" "}
        <a href="https://claude.ai/code" target="_blank" rel="noreferrer">
          claude.ai/code
        </a>{" "}
        in a browser. On a first visit it asks you to connect GitHub: allow it
        for that repository. On the screen where you start a new session, click
        the first control in the row under the message box (the environment
        selector), then <strong>New environment</strong> at the bottom of its
        menu. In the dialog:
        <ul>
          <li>
            <strong>Network access</strong>: <strong>Custom</strong>, with “Also
            include default list” on, and these domains:
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
      </li>
    </ol>
  );
}

export function LocalAgentSetup() {
  return (
    <ol className="tutorial-list">
      <li>
        Install the build tools, icp-cli and mops (this needs{" "}
        <a href="https://nodejs.org/" target="_blank" rel="noreferrer">
          Node.js
        </a>
        ):
        <CodeBlock code={SETUP_SCRIPT} />
      </li>
      <li>
        Claude Code signed in with your Claude plan has the connector already:{" "}
        <code>/mcp</code> lists it. Otherwise connect hosty.live once:
        <CodeBlock code={CLI_CONNECT} />
        then <code>/mcp</code> → <strong>hosty</strong> →{" "}
        <strong>Authenticate</strong>, sign in with your passkey and approve.
        Other tools (Cursor, Codex and the like) take the same address,{" "}
        <code>{CONNECTOR_URL}</code>, and open the hosty.live sign-in.
      </li>
      <li>Start the tool in an empty folder.</li>
    </ol>
  );
}

/// The API token way, still supported, for a cloud session on a plan
/// whose admin has not added the connector.
export function TokenSetup() {
  return (
    <details className="more">
      <summary>No connectors on your Team/Enterprise plan?</summary>
      <p>
        On Team and Enterprise plans only an admin can add connectors. Without
        one, a cloud session reaches hosty.live with an API token instead:
      </p>
      <ol className="tutorial-list">
        <li>
          In {HOSTY}: <strong>Settings</strong> →{" "}
          <strong>AI agent access</strong> → create a token. It starts with{" "}
          <code>hl_</code> and is shown once: keep it for step 3. It is a
          password to your canisters; never paste it into a chat.
        </li>
        <li>
          Add one file at your repository's root named <code>.mcp.json</code>,
          with exactly this content. It tells the session where hosty.live is;
          your token never goes into the repository:
          <CodeBlock code={MCP_JSON} />
        </li>
        <li>
          In the session's environment (as above), add{" "}
          <strong>Network secrets</strong> → <strong>Add secret</strong>: type{" "}
          <strong>Bearer</strong>, name <code>hosty.live</code>, allowed website
          <CodeBlock code={SECRET_HOST} />
          and your <code>hl_</code> token as the value of the{" "}
          <code>Authorization</code> header row (prefix <code>Bearer</code>).
          Claude's servers add it to every request to hosty.live, so the session
          itself never sees your token. On a Team plan without an organization
          admin role the form is shorter: host <code>{SECRET_HOST}</code>,
          secret type <strong>Token</strong>, your token as the value. Then make
          sure it arrives as a Bearer token: the session's first{" "}
          <code>hosty_whoami</code> must answer, not fail with 401.
        </li>
      </ol>
      <p className="hint">
        A session started before the file and the secret existed gets the tools
        once it restarts; a new session on the same branch always has them.
      </p>
    </details>
  );
}

/// Going live through hosty.live: the balance its canisters are paid from.
export function HostyCycles({ cost }: { cost: string }) {
  return (
    <p>
      First top up your hosty.live balance: <strong>Cycles</strong>, then{" "}
      <strong>Deposit using CyclePay</strong> or{" "}
      <strong>Deposit using Cycle Express</strong> (both by card), or{" "}
      <strong>Deposit ICP</strong> if you hold ICP. At the time of writing{" "}
      {cost}.
    </p>
  );
}

/// Going live with icp-cli: the user's own key and cycles, in their own
/// terminal.
export function IcpIdentitySteps({ cycles }: { cycles: string }) {
  return (
    <>
      <li>
        Create your publishing key (keep it; it is what proves the canisters are
        yours), or skip this if you already have an <code>icp</code> identity
        you want to use:
        <CodeBlock
          code={
            "icp identity new my-key\nicp identity default my-key\nicp identity principal"
          }
        />
      </li>
      <li>
        Pay for hosting. Programs on the Internet Computer run on prepaid
        “cycles”; {cycles} at the time of writing. The simplest way is by card
        at{" "}
        <a href="https://cycle.express/" target="_blank" rel="noreferrer">
          cycle.express
        </a>
        : paste the long address that the last command above printed (your
        “principal”) into its Canister ID field. If you already hold ICP,{" "}
        <code>icp cycles mint --icp 1 -e ic</code> converts it instead. Check it
        arrived:
        <CodeBlock code="icp cycles balance -e ic" />
      </li>
    </>
  );
}

export function OwnSetup() {
  return (
    <ol className="tutorial-list">
      <li>
        An AI coding tool on your computer: Claude Code, Cursor, Codex or the
        like.
      </li>
      <li>
        The build tools, icp-cli and mops (this needs{" "}
        <a href="https://nodejs.org/" target="_blank" rel="noreferrer">
          Node.js
        </a>
        ):
        <CodeBlock code={SETUP_SCRIPT} />
      </li>
      <li>Start the tool in an empty folder.</li>
    </ol>
  );
}
