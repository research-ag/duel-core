// What a Claude Code cloud session (claude.ai/code) needs before any of
// the prompts can deploy through hosty.live; the procedure behind it is
// skills/duel-game-core/references/going-live.md, section 2. Keep the
// two in step.

export const MCP_JSON = `{
  "mcpServers": {
    "hosty": {
      "type": "http",
      "url": "https://api.hosty.live/mcp"
    }
  }
}`;

export const SECRET_HOST = "api.hosty.live";

export const NETWORK_DOMAINS = [
  "api.hosty.live",
  "icp-api.io",
  "icp0.io",
  "*.icp0.io",
  "ic0.app",
].join("\n");

export const SETUP_SCRIPT = "npm install -g @icp-sdk/icp-cli ic-mops";

export const SKILL_INSTALL =
  "npx skills add research-ag/duel-core --skill duel-game-core -a claude-code -y --copy";

/// The opening lines every prompt shares: where the tools come from and
/// what the session may never do on mainnet.
export const SESSION_RULES = `If you run in a Claude Code cloud session: its environment installs icp-cli and mops (otherwise install them with ${SETUP_SCRIPT}), and hosty.live's MCP server is connected through the repository's .mcp.json; call hosty_whoami first, and if the hosty_* tools are missing, tell me what is missing from the setup. Nobody can open a page this session serves, so whatever I should look at goes online through hosty.live. Never create an icp-cli identity, buy cycles or run icp deploy -e ic here: everything on mainnet is created and installed through the hosty_* tools, after I approve a deploy session in the hosty.live web app. Commit and push your work as you go; the session keeps nothing.`;
