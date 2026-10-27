# Going live

Read this when something tested locally should be reachable by the
public: a whole game (`SKILL.md` Step 8), a new frontend for an
existing game (`frontend-for-existing-game.md`), or a bot
(`bot-for-existing-game.md`). It is written for a user who may know
nothing about the Internet Computer: follow it with them, one step at a
time, and leave the same steps in the project's `README.md`.

A game is up to three kinds of canister: the backend and a bot
(compiled Motoko modules) and the frontend (static files). Building and
testing happen where the agent runs; putting a canister online is
signed by the user. There are three setups, best first:

|                  | 1. Cloud session + hosty.live                                   | 2. Own computer + hosty.live              | 3. Own computer + icp-cli                                 |
| ---------------- | --------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| The agent runs   | in a Claude Code cloud session (claude.ai/code, the Claude app) | on the user's computer                    | on the user's computer                                    |
| Builds and tests | icp-cli and mops in the session's VM                            | icp-cli and mops on the computer          | icp-cli and mops on the computer                          |
| Who signs        | the user's Internet Identity, approving a hosty.live session    | the same                                  | an icp-cli identity, a key on the user's computer         |
| Paid with        | the hosty.live balance, by card                                 | the same                                  | cycles bought by card at cycle.express: 2T per canister   |
| Deploys          | `hosty_*` tools over hosty.live's MCP server                    | `hosty_*` tools, or the hosty.live web UI | `icp deploy <name> -e ic`                                 |
| The module store | hosty.live stores every module it installs                      | the same                                  | `publish_wasm.sh` uploads it, with a hosty.live API token |
| Suits            | anyone, from any device; nothing to install                     | a user who already runs a coding agent    | a user who already has an identity and cycles, or scripts |

Setups 1 and 2 are the same route, through hosty.live (section 3);
setup 3 is icp-cli all the way (section 4). Keep every canister of a
project on one route. Either way the backend's module ends up in
hosty.live's module store, where other people's frontends and bots
fetch it by the canister's public module hash (backend README,
"Downloadable wasm"); every setup needs a hosty.live account for that,
setup 3 only its API token.

Going live spends the user's money. Create a canister or deploy only
when the user asks for it, after saying what it costs; a hosty.live MCP
server connected to your session is the means, never the permission.
In setup 3, `icp deploy -e ic` is the user's command to run, or yours
when they say so.

The development loop stays local: `mops test`, a local network (`icp
network start -d`, `icp deploy`) and `frontend/play-test.mjs`, in the
session's VM or on the computer. A mainnet install is for a build that
passes all three.

## 1. A hosty.live account and its API token (every setup)

The user, once, in the browser:

1. Sign in at https://hosty.live/ with Internet Identity (a passkey; no
   password, no email).
2. **Settings** → **AI agent access** → name the token (say, "Claude
   Code") → create. The page shows the token (`hl_...`) once, with the
   one-line command that connects Claude Code on a computer to
   hosty.live's MCP server and the equivalent JSON for other MCP
   clients. The token is a password to the user's canisters: revoke it
   on the same page when done, never commit it, never paste it into a
   chat.
3. **Cycles** → **Deposit using Cycle Express** pays the balance by
   card. Prices at the time of writing: a frontend canister 0.84 TC
   (about a dollar), a backend or bot canister 1.5 TC when the agent
   creates it (an install needs 0.5T on the canister itself, after a
   creation fee of about 0.5T). A whole game with a bot is about 4 TC.

Where the token goes next depends on the setup: section 2 for a cloud
session, section 3's first paragraph for an agent on the computer,
section 4 for icp-cli.

## 2. Setup 1: a Claude Code cloud session

A cloud session runs in a fresh virtual machine that is discarded
afterwards. The agent builds and tests there; the user never opens
anything the VM serves (there is no `localhost` to visit), and every
key made in the VM is lost with it. Hence two rules:

- Nothing on mainnet is signed by a key of the session. No `icp
identity new`, no `icp cycles`, no `icp deploy -e ic`: every canister
  is created and installed through the `hosty_*` tools, signed by the
  user's approval in hosty.live.
- The user's first look at anything is online. A new game: its two
  final canisters, created once its local tests pass and kept unlisted
  until it is registered on the Duel dashboard (section 5); every later
  version upgrades them. A new frontend for an existing game: a free
  rented hosty.live canister (`frontend-for-existing-game.md`, step 7).

**Once per project, the user:**

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
     header row (`Authorization`, prefix `Bearer`) section 1's token as
     the value. Anthropic's proxy adds it to every request to
     `api.hosty.live` after the request leaves the session's VM, so the
     session never sees the token. On a Team plan without an
     organization admin role the form is shorter: host
     `api.hosty.live`, secret type **Token**, the token as the value;
     the session's first `hosty_whoami` confirms it arrives as a Bearer
     token.
   - **Network access**: **Custom**, with "Also include default list"
     on, and these domains: `api.hosty.live`, `icp-api.io`, `icp0.io`,
     `*.icp0.io`, `ic0.app`. hosty.live's tools answer with `curl`
     uploads to `api.hosty.live`; mops, icp-cli's mainnet reads and the
     play-test against a deployed backend talk to the others.
   - **Setup script**, which installs every tool before the session
     starts (a binary fetched mid-session may be refused, and icp-cli
     looks up its local network launcher on `api.github.com`, which
     often turns a cloud VM's shared address away; this fetches it
     through `github.com`):

     ```bash
     npm install -g @icp-sdk/icp-cli ic-mops
     tag=$(curl -fsSIL -o /dev/null -w '%{url_effective}' https://github.com/dfinity/icp-cli-network-launcher/releases/latest)
     tag=${tag##*/}
     arch=$(uname -m | sed s/aarch64/arm64/)
     mkdir -p /opt/icp-launcher
     curl -fsSL "https://github.com/dfinity/icp-cli-network-launcher/releases/download/$tag/icp-cli-network-launcher-$arch-linux-$tag.tar.gz" | tar -xz --strip-components=1 -C /opt/icp-launcher
     ```

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

**Deploy sessions from anywhere.** A `userAction` from
`hosty_request_deploy_session` is approved in the hosty.live web app,
on a phone as well as a computer. Relay it verbatim, say what you are
about to create, install or spend, and poll `hosty_get_deploy_session`
until `ACTIVE`.

## 3. Setups 1 and 2: everything through hosty.live

On the user's own computer (setup 2), the agent connects with the
one-line command from section 1 (`claude mcp add --transport http hosty
https://api.hosty.live/mcp --header "Authorization: Bearer hl_..."`),
run by the user in a terminal of their own; after a restart the
`hosty_*` tools appear. Without an agent, every step below has a form
in the hosty.live web app. The server's own guide is
https://api.hosty.live/skill (the MCP resource `hosty://skill` is the
same text), with a REST equivalent of every tool.

### Canisters

With the user's go-ahead and a deploy session (section 2, "Deploy
sessions from anywhere"):

- `hosty_create_canister { kind: "backend" }` for the backend and for
  each bot: created empty, 1.5 TC.
- `hosty_create_canister { kind: "frontend" }` for the page: created
  with hosty's asset module, ready for uploads, 0.84 TC.

A balance too low for a create fails with the amount missing and a card
payment link (`buyUrl`): give it to the user, wait until `hosty_whoami`
shows the new balance, retry. An error naming a canister that was
already created is finished with `hosty_import_canister`, never by
creating another one.

By hand, the same is **Canisters** → **Create New Canister**,
**Backend** or **Frontend**, 0.84 TC each; a backend then needs a
top-up to 0.5T on its own page before the first install.

hosty.live's rented canisters (free, 24 hours, one per user) are for
staging only: a rented canister is wiped when the rent ends.

### The backend (and a bot)

Build the module that passed the local tests, from the project root:

```bash
icp build backend           # .icp/cache/artifacts/backend
```

A gzipped copy (`gzip -k`) installs the same way; the store keeps
whichever file was installed, byte for byte. Then:

1. `hosty_check_backend_canister { canisterId }`. With `ready: true`
   (a deploy session active, or unattended deploys allowed on that
   canister), skip to step 3.
2. `hosty_request_deploy_session { hours: 1 }`, relay its `userAction`,
   say what you are going to install, poll `hosty_get_deploy_session`
   until `status: "ACTIVE"`. The approval covers every canister the
   user controls until it expires.
3. `hosty_prepare_wasm_upload { canisterId, wasmPath:
".icp/cache/artifacts/backend" }`, plus `snapshotBeforeUpgrade: true`
   whenever the canister already runs the game (an upgrade keeps its
   tables; the snapshot is the way back). It returns a `curl` command
   with a 15-minute upload token: run it from the project root. Its
   JSON answer carries the deployment `id`.
4. `hosty_wait_for_deployment { deploymentId }` until `finished: true`,
   again if it is not. On `FAILED`, `statusReason` is the replica's
   reject message verbatim (a trapped `post_upgrade`, too few cycles).
5. Check the game's public faces:

   ```bash
   curl https://<backend-id>.raw.icp0.io/semantics
   ```

   and `hosty_get_module { canisterId }`: the store holds the module
   with `verified: true`. With the frontend built, `cd frontend && node
play-test.mjs <backend-id> --ic` plays whole games against the
   installed backend, on access-code tables.

Without an agent, the backend canister's page in hosty.live takes the
same file in its install form, after the same approval.

A bot goes up the same way (`icp build bot`, its own backend
canister), then lists itself in the game's bot directory: during the
deploy session, `hosty_call_canister` on the bot, method `register`,
argument `(principal "<backend-id>", "<Bot Name>")`, with `update:
true`. An update call in a session is signed as the user, the bot's
controller, which `register` requires: check the reply's `caller` is
the user's principal. `unregister` takes `(principal "<backend-id>")`.

Every later version is steps 1 to 5 again; the canister id stays.
Before each, `cd frontend && node check-upgrade.mjs <backend-id>`
checks the new module's stable types and Candid against the live one,
and you review the code that runs on the upgrade
(`changing-a-live-game.md`, section 4).

### The frontend

The page finds its backend in the `ic_env` cookie its canister sets,
built from the canister's `PUBLIC_*` environment variables; the Duel
dashboard (section 5) reads the same cookie to find the backend a
listed page plays. On the frontend canister that variable is
`PUBLIC_CANISTER_ID:backend`, with the backend's canister id as its
value (the colon is part of the name), and hosty.live sets it: with the
first upload through the agent, or on the canister's page by hand. It
stays through every later upload and reset.

Build and pack, from `frontend/`:

```bash
npm run build && zip -r dist.zip dist -x "*.map"
```

`dist/` is what goes online: `index.html`, `app.js`, the two
stylesheets, and whatever else `build.js` copies, a `_headers` file
included (hosty.live applies it as icp-cli does).

**With the agent:**

1. `hosty_check_canister { canisterId }` until it answers `ready:
true`. A canister created in the web UI needs **Grant agent deploy
   access** clicked once in **Settings**; one created with
   `hosty_create_canister` is ready. Its `environment` shows what the
   page publishes now; an `environment.module` of `LEGACY_ASSETS` means
   the canister can publish no cookie at all, and the user first clicks
   **Reset canister** on its page.
2. Unless `environment` already shows `PUBLIC_CANISTER_ID:backend` with
   this backend's id, setting it signs as the user: a deploy session,
   as for the backend.
3. `hosty_prepare_zip_upload { canisterId, pureAssets: true, outputDir:
"dist", canisterEnv: { set: { "PUBLIC_CANISTER_ID:backend":
"<backend-id>" } } }` returns a `curl` command with a 15-minute upload
   token. hosty.live sets the variable right before the upload, which
   publishes it. Run the command from `frontend/`. Its JSON answer
   carries the deployment `id`.
4. `hosty_wait_for_deployment { deploymentId }` until `finished: true`,
   again if it is not. On `SUCCESS` the answer carries `frontendUrl`;
   on `FAILED`, `statusReason` and `logsTail` say why (a malformed
   `_headers` names its line).
5. Check the cookie, then give the user `frontendUrl`: they play a
   round from two browser tabs (or a computer and a phone) against the
   live backend. Gateways cache for up to a minute after a deploy.

   ```bash
   curl -sI https://<frontend-id>.icp0.io/ | grep -o 'ID%3Abackend%3D[a-z0-9%D-]*cai'
   ```

A later switch to another backend is `hosty_set_canister_env {
canisterId, set: { "PUBLIC_CANISTER_ID:backend": "<backend-id>" } }` in
a deploy session; it publishes at once, with no upload.

**In the web UI:** open the canister → **Canister environment
variables** → **Add variable**, name `PUBLIC_CANISTER_ID:backend`,
value the backend id → **Save and publish** (signed with the user's
Internet Identity, no deploy session). Then **Deploy** → **ZIP
Upload**, pick `dist.zip`, switch on the already-built option (no
build on the server), output directory `dist`, deploy. The
**Deployments** page follows the upload; the canister's page shows the
URL.

Every later version is another build and upload into the same canister;
the variable stays. The user keeps full control of the canister and can
attach a custom domain or make it immutable from the web UI.

## 4. Setup 3: everything with icp-cli

Only on the user's own computer, never in a cloud session (section 2).

**An identity.** `icp-cli` signs every call with a key it keeps on the
user's computer. The user creates it once, in a terminal of their own,
with a name of their choosing:

```bash
icp identity new my-game
icp identity default my-game
icp identity principal        # the long xxxxx-...-xxx address: the user's principal
```

That key is what makes the user the canisters' controller: the only one
who can upgrade or delete them. Backing it up (`icp identity export`)
is the user's own step in that same terminal; never run it yourself or
ask for the key. All you need is the principal, and every `icp`
command you run uses the default identity by itself.

**Cycles.** Canisters pay for their own computation and storage in
cycles, prepaid. Creating one through `icp deploy` takes 2T cycles off
the identity's balance by default, and the canister keeps running on
them for a long time: buy 5T (a few dollars) for a backend and its
frontend, 7T with a bot. The simplest way is by card at
https://cycle.express/: paste the principal that `icp identity
principal` printed into its recipient field, pay with Stripe. Then:

```bash
icp cycles balance -n ic
```

**The token.** The backend's sync step needs section 1's token, in a
file outside the project that only the user can read. The user runs
this in a terminal of their own and pastes the token at the prompt,
which does not echo it or keep it in the shell's history:

```bash
mkdir -p ~/.config/hosty && printf 'hosty.live token: ' && read -rs t && echo && (umask 077 && printf %s "$t" > ~/.config/hosty/token); unset t
```

**Deploy**, from the project root, naming each canister:

```bash
export HOSTY_TOKEN=$(cat ~/.config/hosty/token)
icp deploy backend -e ic              # a game's backend
icp deploy frontend -e ic             # its page; sets the ic_env cookie itself
icp deploy bot -e ic                  # a bot (bot-for-existing-game.md)
```

Always name what to deploy: a bare `icp deploy -e ic` also creates
every other canister in `icp.yaml` on mainnet, 2T cycles each, and for
a project linked to somebody else's backend it fails on that one. The
backend's sync step (`publish_wasm.sh`) runs by itself after every
install and upgrade: it uploads the module the canister now runs to
the store and has the store verify it against the canister. When it
fails (no token, a network error), the canister is installed but its
module is not downloadable yet: fix the cause and run `icp sync
backend -e ic`. Then:

```bash
icp canister status backend -e ic -i  # the backend's canister id: write it down
curl https://<backend-id>.raw.icp0.io/semantics
```

`icp canister status frontend -e ic -i` is the page's id; the page is
at `https://<frontend-id>.icp0.io/`. Later deploys of the same project
upgrade the same canisters. Before each one,
`(cd frontend && node check-upgrade.mjs <backend-id>)` checks the new
module's stable types and Candid against the live one, and you review
the code that runs on the upgrade (`changing-a-live-game.md`, section
4). A canister's
balance shows in `icp canister status <name> -e ic`; topping it up is
cycle.express again, with the canister id as the recipient, or `icp
canister top-up <name> -e ic --amount 1t` from the identity's balance.

A setup-3 canister moves to hosty.live later without a reinstall: add
the user's hosty.live principal (`hosty_whoami`, or **Settings**) as a
controller (`icp canister settings update <id> -n ic --add-controller
<principal>`), then `hosty_import_canister` (or **Canisters** →
**Import canister** in hosty.live).

## 5. List it on the Duel dashboard

The dashboard at https://games.ic0.info/ is where
players find games. The user logs in there (Internet Identity),
registers the frontend by its canister id, with a title, a description
and a banner, and, if hosty.live serves it under a custom domain, that
domain. The dashboard reads the backend from the page's `ic_env`
cookie, checks its `/semantics`, and offers "Make your own frontend"
and "Build a bot" for it to everyone else. Until then, a game is online
but unlisted: only who has its address finds it.
