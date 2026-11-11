# A Claude Code cloud session

Read this first whenever you run in a Claude Code cloud session
(claude.ai/code, the Claude app), before building or testing anything.
The environment it describes is set up once and serves every step,
from the first `mops test` and the local network to going live through
hosty.live (`going-live.md`).

A cloud session runs in a fresh virtual machine that is discarded
afterwards. The agent builds and tests there; the user never opens
anything the VM serves (there is no `localhost` to visit), and every
key made in the VM is lost with it. Hence two rules:

- Nothing on mainnet is signed by a key of the session. No `icp
identity new`, no `icp cycles`, no `icp deploy -e ic`: every canister
  is created and installed through the `hosty_*` tools, signed by the
  user's approval in hosty.live.
- The user's first look at anything is online, on free cloud engine
  canisters when hosty.live has an engine with a free slot
  (`hosty_whoami`; `going-live.md`, section 3, "Canisters"). A new
  game: a cloud engine backend and frontend (and bot), created once its
  local tests pass; every later version redeploys into them until the user says the game
  goes live, which buys its mainnet canisters. If hosty.live deletes
  one of these cloud engine canisters, its replacement is created on
  the cloud engine, never on mainnet, and set up by kind: a backend is
  installed, the page's `PUBLIC_CANISTER_ID:backend` set to it and
  every bot registered with it again; a frontend gets the build
  uploaded with `PUBLIC_CANISTER_ID:backend` naming the backend, and
  the user its new address; a bot is installed and registered with the
  backend. Then give the user the new ids. A new frontend for an
  existing game: a cloud engine page (`frontend-for-existing-game.md`,
  step 7). Without an engine, the first look is the mainnet canisters
  themselves: say what they cost and create them only once the user
  agrees.

**Once, before the first build, the user:**

1. Adds the hosty.live connector in claude.ai (`going-live.md`,
   section 1). Its tool calls go from Anthropic's servers to
   hosty.live, outside the session's VM and its network list, and no
   credential enters the VM. Every new session has the `hosty_*` tools.
2. Creates a GitHub repository (with **Add README** on, so it is not
   empty). One serves all their work: every game, frontend or bot is a
   top-level directory of its own in it (below).
3. Opens https://claude.ai/code in a browser and, on a first visit,
   connects GitHub for that repository. Then gets the cloud environment
   below, named `hosty.live`, in one of two ways:
   - **By one message** (the Duel dashboard's guides show it): in a
     session on that repository, on any environment, the user asks for
     the environment with the values below. That session saves them
     with its built-in `create_environment` tool (`update_environment`
     for one that exists), after the user approves the **Create new
     environment?** card claude.ai shows, scrolled to its end. In that
     session, you: check the script with `bash -n`, but do not run it
     there; show the values and ask before saving. The tool refuses
     wildcard domains: leave `*.icp0.io` and `*.icp.net` out when it
     does and say so, and the user adds them by hand (the gear icon on
     the environment's row in the selector → **Network access** →
     **Allowed domains**). The tool reports that a script or variable
     is set, not its text; the edit dialog shows both.
   - **By hand**: on the new-session screen, the environment selector
     (the first control under the message box) → **New environment**,
     or the gear icon that hovering over an existing one's row shows.
     In a running session the same dialog is the caret after the
     session title → **Edit cloud environment**.

   The environment must be complete before the session that builds
   starts: a running session never sees a change to it, and only a new
   session picks the change up. The values:

   - **Network access**: **Limited**, with **Allow package managers**
     on, and under **Allowed domains**, one per line: `api.hosty.live`, `icp-api.io`, `icp0.io`,
     `*.icp0.io`, `icp.net`, `*.icp.net`, `ic0.app`,
     `ic-api.internetcomputer.org`, `ghcr.io`,
     `pkg-containers.githubusercontent.com`. hosty.live's tools answer
     with `curl` uploads to `api.hosty.live`; the Duel dashboard hands
     out game addresses on `icp.net`; a bot's subnet lookup goes
     to `ic-api.internetcomputer.org`; the setup script below fetches
     icp-cli's local network launcher from `ghcr.io`, whose downloads
     redirect to `pkg-containers.githubusercontent.com`; mops, icp-cli's
     mainnet reads and the play-test against a deployed backend talk to
     the others.
   - **Setup script**, which installs every tool before the session
     starts. icp-cli downloads its local network launcher from GitHub
     releases, which a cloud session cannot reach (GitHub access there
     is granted per repository, not per domain), so the script takes the
     launcher and `pocket-ic` from DFINITY's official
     `dfinity/icp-cli-network-launcher` container image on `ghcr.io`
     (linux/amd64, pinned by digest). A failed download still lets the
     session start; only `icp network start` then fails:

     ```bash
     npm install -g @icp-sdk/icp-cli@1.8.0 ic-mops
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
     ls -l "$L" || true
     ```

     The icp-cli version and the image digest go together: a newer
     icp-cli may need a newer launcher image, so update both at once.

   - **Environment variables**: `ICP_CLI_NETWORK_LAUNCHER_PATH=/opt/icp-launcher/icp-cli-network-launcher`,
     so `icp network start` uses that launcher.

   By hand, finish with **Add environment** (or save the edit).

4. Starts a new session on that repository with that environment
   (under **More** in the selector when it is not listed). Every later
   game, frontend or bot starts the same way, in the same repository
   and environment.

**In the session, you:**

- Check `icp --version`, `mops --version` and `hosty_whoami` first,
  tell the user what you found, and build meanwhile.
- A `mops` older than 3.4.1: `npm install -g ic-mops` (`SKILL.md`,
  Step 1).
- A missing `icp` or `mops`: the environment lacks the setup script, or
  gained it after this session started. Run the script above yourself,
  with `ICP_CLI_NETWORK_LAUNCHER_PATH` set as above for every `icp`
  command, and tell the user to complete the environment for the next
  session; with the `update_environment` tool, offer to save the script
  there yourself, for the user's approval.
- Missing `hosty_*` tools: the connector is not added
  (https://claude.ai/customize/connectors), switched off for this
  session (the **+** under the message box → **Connectors**), or in
  need of reconnecting (in the connector settings; hosty.live shows
  connected apps under **Settings** → **AI agent access**, and
  disconnecting one there ends its deploy sessions until the user
  reconnects). The user fixes each in claude.ai, and a new session has
  the tools. Never offer the user a sign-in from the session:
  connectors are authorized in claude.ai.
- A `hosty` server from a `.mcp.json` in the repository that "requires
  authentication" is left over from the token setup below: tell the
  user to delete that `.mcp.json`, unless they set up the token way on
  purpose.
- Every deploy session goes as `going-live.md`, section 2, says: its
  purpose first, its request code for the user, and
  `hosty_wait_for_deploy_session` right away.

The repository holds one top-level directory per project (a game, a
frontend, a bot): a new one goes into a new directory named after it,
unless the user names one, and leaves the others alone; a project
already at the root stays there. Keep each project's `CLAUDE.md` and
`README.md` in its directory, and run its commands from there.

The skill comes through the connector, not from the repository: every
session loads it with `hosty_get_skill { url:
"https://github.com/research-ag/duel-core/tree/main/skills/duel-game-core" }`,
and each file it names with `{ url, path }` (`SKILL.md`, "Where these
files are"). So that a later session finds it without the Duel
dashboard's prompt, the repository's root `CLAUDE.md` names it: create
the file when it is missing, or add this line to it:

```markdown
Games, frontends and bots here are built on duel-game-core: before working on one, load its skill with hosty.live's `hosty_get_skill { url: "https://github.com/research-ag/duel-core/tree/main/skills/duel-game-core" }`.
```

A copy in `.claude/skills/duel-game-core/` from an earlier setup is
loaded by Claude Code too and may be out of date: follow the one
`hosty_get_skill` returns, and offer the user to delete the copy.
Commit and push your work as you go: the VM keeps nothing. A session pushes to a
branch of its own (`claude/...`); once the game works, merge it into
the default branch (or open a pull request there, as the user
prefers), so the next session finds the game where it looks first.
From the first deploy on, keep the project's `CLAUDE.md`
(`templates/CLAUDE.md.template`, in its directory) current: the canister ids and what
each one runs.

## Without connectors: an API token

On Team and Enterprise plans only an admin can add connectors. Where
none is added, a cloud session reaches hosty.live with an API token
instead, which hosty.live supports as well. An agent on the user's
computer needs none of this: it connects with `claude mcp add`
(`going-live.md`, section 3). The user, once, in addition to the
environment above:

1. Creates the token in hosty.live: **Settings** → **AI agent access**
   → create. It starts with `hl_` and is shown once. It is a password
   to the user's canisters: never commit it, never paste it into a
   chat, and revoke it on the same page when done. On an approval
   request they did not expect, the user clicks **Decline and revoke
   token** on its card.
2. Adds one file at the repository's root, `.mcp.json`, with exactly
   this content (`templates/mcp.json.template`). It holds no token:

   ```json
   {
     "mcpServers": {
       "hosty": {
         "type": "http",
         "url": "https://api.hosty.live/mcp"
       }
     }
   }
   ```

3. In the environment, **Network secrets** → **+ Add secret**:
   - **Host**: `api.hosty.live`;
   - **Secret type**: **Token**, with **Header** `Authorization` and
     **Prefix** `Bearer` as they are;
   - **Token**: the `hl_` token.

   Anthropic's proxy adds it to every request to `api.hosty.live` after
   the request leaves the session's VM, so the session never sees the
   token. The session's first `hosty_whoami` confirms it arrives.

Where the user cannot add a network secret (an Enterprise seat without
an organization admin role, an organization with customer-managed
encryption keys), the fallback is an environment variable: add
`"headers": { "Authorization": "Bearer ${HOSTY_TOKEN}" }` to the
server in `.mcp.json` (still no token in the file) and
`HOSTY_TOKEN=hl_...` under the environment's **Environment variables**.
Anyone who uses that environment, and every command the session runs,
can read such a variable; revoke the token when the work is done.

**In a session on the token setup, you:** reading `.mcp.json` does not
connect its server; that happens when the session starts. Missing
`hosty_*` tools mean the file or the secret is missing: without
`.mcp.json`, write it from the template, commit and push it; without
the network secret, the user adds it to the environment. The tools
appear once the session restarts, which a new session on the same
branch always does. A `401` from `hosty_whoami` means the server was
reached but the token was not accepted: the user checks `.mcp.json`,
that the network secret's host is `api.hosty.live` and sends the token
as `Bearer`, and that the token is not revoked. Never ask for the
token, and never write it into a file or a command.
