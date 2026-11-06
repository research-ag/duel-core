# A Claude Code cloud session

Read this first whenever you run in a Claude Code cloud session
(claude.ai/code, the Claude app), before building or testing anything.
The environment it describes is set up once per project and serves
every step, from the first `mops test` and the local network to going
live through hosty.live (`going-live.md`).

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
  (`hosty_whoami`; `going-live.md`, section 3, "Canisters"). A new game: a cloud engine
  backend and frontend (and bot), created once its local tests pass;
  every later version redeploys into them until the user says the game
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

**Once per project, before the first build, the user** sets up the
repository and the session's environment. Building and testing need
only its network access, setup script and environment variable; the
hosty.live network secret (a hosty.live account and its API token,
`going-live.md`, section 1) can follow when the game is ready for its
first look online. The user:

1. Creates a GitHub repository (empty is fine) and adds one file at its
   root, `.mcp.json`, with exactly this content (on GitHub: **Add
   file** → **Create new file**), from `templates/mcp.json.template`:

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

   It holds no token, and none ever goes into the repository: the next
   step adds it outside the session.

2. Opens https://claude.ai/code in a browser (in the desktop app, its
   **Code** tab, not the chat home) and, on a first visit, connects
   GitHub for that repository. On the new-session screen, opens the
   environment selector (the first control under the message box) and
   either picks **New environment** or edits **Default** (the settings
   icon on its row under **Cloud**). In a running session the same
   dialog is the caret after the session title → **Edit cloud
   environment**. In it:
   - **Network secrets** → **Add secret**: secret type **Bearer**, name
     `hosty.live`, allowed website `api.hosty.live`, and in the custom
     header row (`Authorization`, prefix `Bearer`) the token from
     `going-live.md`, section 1, as
     the value. Anthropic's proxy adds it to every request to
     `api.hosty.live` after the request leaves the session's VM, so the
     session never sees the token. On a Team plan without an
     organization admin role the form is shorter: host
     `api.hosty.live`, secret type **Token**, the token as the value;
     the session's first `hosty_whoami` confirms it arrives as a Bearer
     token.
   - **Network access**: **Custom**, with "Also include default list"
     on, and these domains: `api.hosty.live`, `icp-api.io`, `icp0.io`,
     `*.icp0.io`, `ic0.app`, `ic-api.internetcomputer.org`, `ghcr.io`,
     `pkg-containers.githubusercontent.com`. hosty.live's tools answer
     with `curl` uploads to `api.hosty.live`; a bot's subnet lookup goes
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
     if [ ! -x "$L/icp-cli-network-launcher" ]; then
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

3. Starts a session on that repository with that environment.

Where the user cannot add a network secret (an Enterprise seat without
an organization admin role, an organization with customer-managed
encryption keys), the fallback is an environment variable: add
`"headers": { "Authorization": "Bearer ${HOSTY_TOKEN}" }` to the
server in `.mcp.json` (still no token in the file) and
`HOSTY_TOKEN=hl_...` under the environment's **Environment variables**.
Anyone who uses that environment, and every command the session runs,
can read such a variable; revoke the token when the project is done.

**In the session, you:** check `icp --version`, `mops --version` and
`hosty_whoami` first. A missing `hosty_*` tool means the setup is
incomplete: without `.mcp.json`, write it from the template, commit
and push it; without the network secret, the user adds it to the
environment; the tools appear in the next session on that branch. A
`401` from `hosty_whoami` means the server was reached but the token
was not accepted: the user checks `.mcp.json`, that the network
secret's host is `api.hosty.live` and sends the token as `Bearer`, and
that the token is not revoked (**Settings** → **AI agent access**).
Either way, tell the user and build meanwhile. Never ask for the token,
and never write it into a file or a command. Unless
`.claude/skills/duel-game-core/` is already there, install this skill
into the repository and commit it:

```bash
npx skills add research-ag/duel-core --skill duel-game-core -a claude-code -y --copy
```

It lands in `.claude/skills/duel-game-core/`, which later sessions load
by themselves; in this one, read its `SKILL.md` from there. Commit and
push your work as you go: the VM keeps nothing. A session pushes to a
branch of its own (`claude/...`); once the game works, merge it into
the default branch (or open a pull request there, as the user
prefers), so the next session finds the game where it looks first.
From the first deploy on, keep the repository's `CLAUDE.md`
(`templates/CLAUDE.md.template`) current: the canister ids and what
each one runs.
