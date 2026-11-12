// The setup steps the guides share (cloudSession.ts has the texts): the
// hosty.live connector, then either a Claude Code cloud session (with the
// API token way for a plan without connectors) or an agent on the
// computer, and the cycles each way pays for going live with.

import { useState } from "react";

import {
  CLI_CONNECT,
  CONNECTOR_URL,
  CONNECTORS_PAGE,
  ENV_NAME,
  ENV_SETUP_PROMPT,
  INSTALL_TOOLS,
  LAUNCHER_ENV,
  MCP_JSON,
  NETWORK_DOMAINS,
  SECRET_HOST,
  SETUP_SCRIPT,
  WILDCARD_DOMAINS,
} from "../cloudSession";
import { CodeBlock } from "./CodeBlock";
import { WayPicker } from "./WayPicker";

const HOSTY = (
  <a href="https://hosty.live/" target="_blank" rel="noreferrer">
    hosty.live
  </a>
);

type Where = "cloud" | "computer";

/// The whole hosty.live setup: the connector once, then one path for
/// where the agent runs.
export function HostySetup() {
  const [where, setWhere] = useState<Where>();
  return (
    <>
      <p>
        <strong>Once: connect Claude to hosty.live.</strong>
      </p>
      <ConnectorSteps />
      <p>
        <strong>Then pick where the AI works:</strong>
      </p>
      <WayPicker
        picked={where}
        onPick={setWhere}
        options={[
          {
            way: "cloud",
            title: "In the cloud",
            note: "Claude Code on Anthropic's servers, in the browser at claude.ai/code or in the Claude desktop app's Code tab. Send the prompt, close your laptop and come back later; you look at your work online, on hosty.live. Nothing to install.",
          },
          {
            way: "computer",
            title: "On your computer",
            note: "Claude Code in a terminal or in the desktop app's Code tab (a local session), or another AI coding tool such as Cursor or Codex. You install the build tools.",
          },
        ]}
      />
      {where === "cloud" && (
        <>
          <CloudSessionSetup />
          <TokenSetup />
        </>
      )}
      {where === "computer" && <LocalAgentSetup />}
    </>
  );
}

export function ConnectorSteps() {
  return (
    <>
      <ol className="tutorial-list">
        <li>
          Open{" "}
          <a href={CONNECTORS_PAGE} target="_blank" rel="noreferrer">
            Claude's connector settings
          </a>{" "}
          and click <strong>+ Add</strong> →{" "}
          <strong>Add custom connector</strong>. Paste this address:
          <CodeBlock code={CONNECTOR_URL} />
        </li>
        <li>
          {HOSTY} opens. Sign in with Internet Identity (a passkey; no password,
          no email) and approve. Once per Claude account: claude.ai, its cloud
          sessions, the desktop app and Claude Code on your computer then all
          have hosty.live's tools.
        </li>
      </ol>
      <p className="hint">
        If a session later says it has no hosty.live tools, the connector is
        switched off for that session (the <strong>+</strong> under the message
        box → <strong>Connectors</strong>) or needs reconnecting, in the same
        connector settings. Fix it there and start a new session. On your
        computer, <code>/mcp</code> shows it.
      </p>
    </>
  );
}

export function CloudSessionSetup() {
  return (
    <>
      <ol className="tutorial-list">
        <li>
          Create a repository on{" "}
          <a href="https://github.com/new" target="_blank" rel="noreferrer">
            GitHub
          </a>{" "}
          and switch on <strong>Add README</strong>: that gives it the main
          branch every session starts from. One is enough for all your work:
          every game, page or bot gets a folder of its own in it.
        </li>
        <li>
          Open{" "}
          <a href="https://claude.ai/code" target="_blank" rel="noreferrer">
            claude.ai/code
          </a>{" "}
          in a browser (or the desktop app's Code tab, with an environment under{" "}
          <strong>Cloud</strong>). On a first visit it asks you to connect
          GitHub: allow it for that repository. On the screen where you start a
          new session, pick your repository in the row under the message box
          (any environment will do) and send this message. It has Claude create
          the session's environment, named <code>{ENV_NAME}</code>: its network
          access, a setup script that installs the build tools before each
          session starts, and one variable.
          <CodeBlock code={ENV_SETUP_PROMPT} />
        </li>
        <li>
          Claude checks the setup script, then claude.ai asks you with a{" "}
          <strong>Create new environment?</strong> card listing the values:
          scroll to its end and click <strong>Create environment</strong>. That
          session is done: it keeps the environment it started with.
        </li>
        <li>
          Click <strong>New</strong> at the top of the sidebar. In the row under
          the message box, click the environment selector (the first control)
          and type <code>{ENV_NAME}</code> in its search box. Claude cannot add
          domains with a <code>*</code>, so add{" "}
          {WILDCARD_DOMAINS.map((d, i) => (
            <span key={d}>
              {i > 0 && " and "}
              <code>{d}</code>
            </span>
          ))}{" "}
          yourself: hover over <code>{ENV_NAME}</code>, click its gear icon,
          then <strong>Network access</strong>, add them to{" "}
          <strong>Allowed domains</strong>, one per line, and click{" "}
          <strong>Save changes</strong>.
        </li>
        <li>
          Then click <code>{ENV_NAME}</code> itself in the same selector to pick
          it, check that your repository is next to it, and send the prompt from
          the next step. A running session never sees a change to its
          environment: after any change, start a new session. Your next game,
          page or bot starts the same way, in the same repository and
          environment.
        </li>
      </ol>
      <details className="more">
        <summary>Or set up the environment by hand</summary>
        <p>
          Click <strong>New</strong> at the top of the sidebar, open the
          environment selector under the message box and click{" "}
          <strong>New environment</strong> at the bottom of its menu (or the
          gear icon that hovering over an existing one shows). Name it{" "}
          <code>{ENV_NAME}</code>, then:
        </p>
        <ul>
          <li>
            <strong>Network access</strong>: keep <strong>Limited</strong> and{" "}
            <strong>Allow package managers</strong>, and put these under{" "}
            <strong>Allowed domains</strong>:
            <CodeBlock code={NETWORK_DOMAINS} />
          </li>
          <li>
            <strong>Setup script</strong>:
            <CodeBlock code={SETUP_SCRIPT} />
          </li>
          <li>
            <strong>Environment variables</strong>:
            <CodeBlock code={LAUNCHER_ENV} />
          </li>
        </ul>
        <p>
          Then <strong>Add environment</strong>, and start a new session on it
          as in the last step above.
        </p>
      </details>
    </>
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
        <CodeBlock code={INSTALL_TOOLS} />
      </li>
      <li>
        Claude Code signed in with your Claude plan, in a terminal or in a local
        session of the desktop app's Code tab, has the connector already:{" "}
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
          On your repository's page on GitHub, <strong>Add file</strong> →{" "}
          <strong>Create new file</strong>, name it <code>.mcp.json</code>,
          paste exactly this and click <strong>Commit changes</strong>. It tells
          the session where hosty.live is; your token never goes into the
          repository:
          <CodeBlock code={MCP_JSON} />
        </li>
        <li>
          In the settings of your <code>{ENV_NAME}</code> environment (its gear
          icon in the environment selector, as above),{" "}
          <strong>Network secrets</strong> → <strong>+ Add secret</strong>:
          <ul>
            <li>
              <strong>Host</strong>:
              <CodeBlock code={SECRET_HOST} />
            </li>
            <li>
              <strong>Secret type</strong>: <strong>Token</strong>, with{" "}
              <strong>Header</strong> <code>Authorization</code> and{" "}
              <strong>Prefix</strong> <code>Bearer</code> as they are.
            </li>
            <li>
              <strong>Token</strong>: your <code>hl_</code> token.
            </li>
          </ul>
          Claude's servers add it to every request to hosty.live, so the session
          itself never sees your token.
        </li>
      </ol>
      <p className="hint">
        A session started before the file and the secret existed gets the tools
        once it restarts; a new session on the same branch always has them. An
        approval request you did not expect:{" "}
        <strong>Decline and revoke token</strong> on its card in hosty.live.
        Revoke the token there too once the work is done. Claude Code on your
        computer needs none of this (<strong>On your computer</strong> above).
      </p>
    </details>
  );
}

/// What a deploy session is for, and how to tell the agent's request apart.
export function DeploySessionNote() {
  return (
    <p className="hint">
      Connected, hosty.live lets the AI use free cloud engine canisters and
      upload pages into canisters you already have. Anything that spends your
      cycles or acts as you on mainnet (buying a canister, a top-up, installing
      a backend or bot, changing a page's settings) waits for a{" "}
      <strong>deploy session</strong> you approve each time. The AI says what it
      is for and shows you a request code. Open {HOSTY} (a phone works too),
      check that the request shows the same code and purpose, and approve it
      with your passkey: the AI notices by itself. A request you did not expect:{" "}
      <strong>Decline and disconnect app</strong>.
    </p>
  );
}

/// Going live through hosty.live: the balance its canisters are paid from.
export function HostyCycles({ cost }: { cost: string }) {
  return (
    <p>
      First top up your hosty.live balance: <strong>Cycles</strong>, then{" "}
      <strong>Deposit using CyclePay</strong> or{" "}
      <strong>Deposit using Cycle Express</strong> (both by card), or{" "}
      <strong>Deposit ICP</strong> if you hold ICP. {cost}
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
        “cycles”; {cycles}. The simplest way is by card at{" "}
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
        <CodeBlock code={INSTALL_TOOLS} />
      </li>
      <li>Start the tool in an empty folder.</li>
    </ol>
  );
}
