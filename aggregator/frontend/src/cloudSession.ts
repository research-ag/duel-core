// What an agent needs before any of the hosty.live prompts can deploy:
// the hosty.live connector, and for a Claude Code cloud session
// (claude.ai/code) its environment. The procedure behind it is
// skills/duel-game-core/references/going-live.md, section 1, and
// cloud-session.md. Keep them in step.

/// The three ways through the guides: caffeine.ai alone; hosty.live,
/// from a cloud session or an agent on the computer; or everything the
/// user's own, icp-cli on their computer.
export type Way = "caffeine" | "hosty" | "own";

export const CONNECTOR_URL = "https://api.hosty.live/mcp";
export const CONNECTORS_PAGE = "https://claude.ai/customize/connectors";
export const CLI_CONNECT = `claude mcp add --transport http hosty ${CONNECTOR_URL}`;

// The API token way, only for a plan without connectors.
export const MCP_JSON = `{
  "mcpServers": {
    "hosty": {
      "type": "http",
      "url": "${CONNECTOR_URL}"
    }
  }
}`;

export const SECRET_HOST = "api.hosty.live";

export const NETWORK_DOMAINS = [
  "api.hosty.live",
  "icp-api.io",
  "icp0.io",
  "*.icp0.io",
  "icp.net",
  "*.icp.net",
  "ic0.app",
  "ic-api.internetcomputer.org",
].join("\n");

export const SETUP_SCRIPT = "npm install -g @icp-sdk/icp-cli ic-mops";

export const SKILL_INSTALL =
  "npx skills add research-ag/duel-core --skill duel-game-core -a claude-code -y --copy";

/// The opening lines every hosty.live prompt shares: where the tools come
/// from, what to say when they are missing, and what the agent may never
/// do on mainnet.
export const SESSION_RULES = `hosty.live's tools (hosty_*) come from the hosty.live connector I added in claude.ai; call hosty_whoami first. If the hosty_* tools are missing, tell me which of three it is: the connector is not added (${CONNECTORS_PAGE}), it is switched off for this session (the + under the message box → Connectors), or it needs reconnecting in claude.ai's connector settings; a new session has the tools once that is fixed. On my computer, the fix is ${CLI_CONNECT}, then /mcp → hosty → Authenticate. Never offer me a sign-in from this session. A hosty server from a .mcp.json in the repository that says it needs authentication is left over from an older setup: tell me to delete that .mcp.json, unless I told you I connect with an API token. Build and test meanwhile. If you run in a Claude Code cloud session: its environment installs icp-cli and mops (otherwise install them with ${SETUP_SCRIPT}). Nobody can open a page that session serves, so whatever I should look at goes online through hosty.live. Never create an icp-cli identity, buy cycles or run icp deploy -e ic there: everything on mainnet is created and installed through the hosty_* tools, after I approve a deploy session in the hosty.live web app. Commit and push your work as you go; the session keeps nothing.`;

/// The opening lines of every prompt on the user's own way: no hosty.live,
/// icp-cli on the computer, the user's own identity and cycles.
export const OWN_RULES = `You run on my computer, with icp-cli (https://github.com/dfinity/icp-cli) and mops (https://mops.one): check icp --version and mops --version first, and if either is missing, ask me to run ${SETUP_SCRIPT}. Do not use hosty.live's tools or an account there (its public module store needs neither): everything goes online with icp-cli, signed by my own icp identity and paid with my own cycles. Never create an identity, export a key or buy cycles yourself: those are my steps, in my own terminal.`;
