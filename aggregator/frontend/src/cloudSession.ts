// What an agent needs before any of the hosty.live prompts can deploy:
// the hosty.live connector, and for a Claude Code cloud session
// (claude.ai/code) its environment, then the framework's skill through
// the connector. The procedure behind it is
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

const DOMAINS = [
  "api.hosty.live",
  "icp-api.io",
  "icp0.io",
  "*.icp0.io",
  "icp.net",
  "*.icp.net",
  "ic0.app",
  "ic-api.internetcomputer.org",
  "ghcr.io",
  "pkg-containers.githubusercontent.com",
];

export const NETWORK_DOMAINS = DOMAINS.join("\n");

/// The domains claude.ai's environment tools refuse (no wildcards), which
/// the user adds by hand.
export const WILDCARD_DOMAINS = DOMAINS.filter((d) => d.startsWith("*."));

/// icp-cli and mops on a computer of the user's own.
export const INSTALL_TOOLS = "npm install -g @icp-sdk/icp-cli ic-mops";

/// A cloud environment's setup script: icp-cli, mops and icp-cli's local
/// network launcher (cloud-session.md explains it).
export const SETUP_SCRIPT = `npm install -g @icp-sdk/icp-cli@1.8.0 ic-mops
L=/opt/icp-launcher
if [ ! -x "$L/icp-cli-network-launcher" ] || [ ! -x "$L/pocket-ic" ]; then
  R=dfinity/icp-cli-network-launcher
  M=sha256:7a98f5bd3094f79c36adc7e8c4cc2a79886d091ec23f8fcc78caae364d54e91e # linux/amd64
  T=$(curl -fsS "https://ghcr.io/token?scope=repository:$R:pull" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
  W=$(mktemp -d)
  curl -fsS -H "Authorization: Bearer $T" -H "Accept: application/vnd.oci.image.manifest.v1+json" "https://ghcr.io/v2/$R/manifests/$M" -o "$W/m.json"
  for D in $(python3 -c 'import json,sys;print(" ".join(l["digest"] for l in json.load(open(sys.argv[1]))["layers"]))' "$W/m.json"); do
    curl -fsSL -H "Authorization: Bearer $T" "https://ghcr.io/v2/$R/blobs/$D" | tar -xz -C "$W" --wildcards 'app/*' 2>/dev/null || true
  done
  mkdir -p "$L" && cp "$W/app/icp-cli-network-launcher" "$W/app/pocket-ic" "$L/" && rm -rf "$W"
fi
ls -l "$L" || true`;

export const LAUNCHER_ENV =
  "ICP_CLI_NETWORK_LAUNCHER_PATH=/opt/icp-launcher/icp-cli-network-launcher";

export const ENV_NAME = "hosty.live";

/// The message that has a cloud session create the environment with the
/// values above (claude-code-remote's create_environment).
export const ENV_SETUP_PROMPT = `Create a Claude Code cloud environment for me with your create_environment tool, or update it with update_environment if I already have one named ${ENV_NAME}. Use exactly these values, nothing else:

Name: ${ENV_NAME}
Repository: the one this session runs on
Network access: Limited, with "Allow package managers" on, and these allowed domains:
${DOMAINS.filter((d) => !WILDCARD_DOMAINS.includes(d)).join("\n")}
Also ${WILDCARD_DOMAINS.join(" and ")} if the tool takes wildcard domains.
Environment variable: ${LAUNCHER_ENV}
Secrets: none
Setup script, exactly the lines inside this block:
\`\`\`bash
${SETUP_SCRIPT}
\`\`\`

Check the script with bash -n, but do not run it in this session. Ask me before saving. Afterwards tell me which domains you could not add, so I add them by hand.`;

/// The skill on the own way, installed on the user's computer.
export const SKILL_INSTALL =
  "npx skills add research-ag/duel-core --skill duel-game-core -a claude-code -y --copy";

/// The skill on the hosty.live way: hosty.live's connector loads it from
/// this address (hosty_get_skill), wherever the agent runs.
export const SKILL_URL =
  "https://github.com/research-ag/duel-core/tree/main/skills/duel-game-core";

/// How every hosty.live prompt hands the work to the skill, which carries
/// every rule the work needs (cloud-session.md, going-live.md): load it,
/// or one of its references for a task it covers, and say what is wrong
/// when the connector's tools are missing.
export function loadSkill(reference?: string): string {
  const url = `"url": "${SKILL_URL}"`;
  const follow = reference
    ? `, then its ${reference} ({ ${url}, "path": "${reference}" }), and follow that reference: it is the procedure for exactly this task`
    : ", and follow it";
  return `Load the duel-game-core skill with hosty.live's hosty_get_skill tool, { ${url} }${follow}. If the hosty_* tools are missing, tell me whether the hosty.live connector is not added (${CONNECTORS_PAGE}), switched off for this session (the + under the message box → Connectors) or in need of reconnecting, and never offer me a sign-in from here.`;
}

/// The opening lines of every prompt on the user's own way: no hosty.live,
/// icp-cli on the computer, the user's own identity and cycles.
export const OWN_RULES = `You run on my computer, with icp-cli (https://github.com/dfinity/icp-cli) and mops (https://mops.one): check icp --version and mops --version first, and if either is missing or mops is older than 3.4.1, ask me to run ${INSTALL_TOOLS}. Do not use hosty.live's tools or an account there (its public module store needs neither): everything goes online with icp-cli, signed by my own icp identity and paid with my own cycles. Never create an identity, export a key or buy cycles yourself: those are my steps, in my own terminal.`;
