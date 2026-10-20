# Going live

Read this when something tested locally should be reachable by the
public: a whole game (`SKILL.md` Step 8), a new frontend for an
existing game (`frontend-for-existing-game.md`), or a bot
(`bot-for-existing-game.md`). It is written for a user who may know
nothing about the Internet Computer: follow it with them, one step at a
time, and leave the same steps in the project's `README.md`.

A game is up to three kinds of canister: the backend and a bot
(compiled Motoko modules) and the frontend (static files). They go
online one of two ways; ask the user which, and keep every canister of
a project on the same one.

|                  | Route A: hosty.live                                             | Route B: icp-cli                                                   |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| Who signs        | the user's Internet Identity, in the hosty.live tab             | an icp-cli identity, a key on the user's computer                  |
| Paid with        | the hosty.live balance, by card: 0.84 TC per canister           | cycles bought by card at cycle.express: 2T per canister            |
| Backend, bot     | `hosty_*` tools (or the web UI), after one approval per session | `icp deploy backend -e ic`, `icp deploy bot -e ic`                 |
| Frontend         | a ZIP upload, with the backend id as a canister variable        | `icp deploy frontend -e ic`                                        |
| The module store | hosty.live stores every module it installs                      | `publish_wasm.sh` uploads it, with a hosty.live API token          |
| Suits            | a user new to the Internet Computer, an AI agent at the wheel   | a user who already has an identity and cycles, or scripted deploys |

Prices are those at the time of writing (0.84 TC is about a dollar).
Either way the backend's module ends up in hosty.live's module store,
where other people's frontends and bots fetch it by the canister's
public module hash (backend README, "Downloadable wasm"); both routes
need a hosty.live account for that, route B only its API token.

Going live spends the user's money. Run a deploy, of either route, only
when the user asks for that deploy; a hosty.live MCP server connected
to your session is the means, never the permission. In route B, `icp
deploy` is the user's command to run, or yours when they say so.

The development loop stays local (`icp network start -d`, `icp
deploy`): a mainnet install is for the finished build. For the first
one, a rented hosty.live backend canister (`hosty_rent_canister {
kind: "backend" }`, free, wiped after 24 hours) is a staging target
that costs nothing.

## 1. A hosty.live account and its API token (both routes)

The user, once, in the browser:

1. Sign in at https://hosty.live/ with Internet Identity (a passkey; no
   password, no email).
2. **Settings** → **AI agent access** → name the token (say, "Claude
   Code on my laptop") → create. The page shows the token (`hl_...`)
   once, and next to it the one-line command that connects Claude Code
   to hosty.live's MCP server:

   ```bash
   claude mcp add --transport http hosty https://api.hosty.live/mcp --header "Authorization: Bearer hl_..."
   ```

   (and the equivalent JSON for Cursor, Windsurf and other MCP
   clients). The token is a password to the user's canisters: revoke it
   on the same page when done, never commit it.

3. Route A: run that command and restart the agent session, so the
   `hosty_*` tools appear. `hosty_whoami` confirms the token and lists
   the user's canisters. The server's own guide is
   https://api.hosty.live/skill (the MCP resource `hosty://skill` is
   the same text), with a REST equivalent of every tool.
4. Route B: keep the token for the backend's sync step, in a file
   outside the project that only the user can read:

   ```bash
   mkdir -p ~/.config/hosty && printf %s 'hl_...' > ~/.config/hosty/token && chmod 600 ~/.config/hosty/token
   ```

   The user runs that in a terminal of their own; never ask for the
   token in the chat.

## 2. Route A: everything through hosty.live

### Canisters

The user creates each canister in hosty.live: **Canisters** → **Create
New Canister**, **Backend** for the backend and for each bot (created
empty), **Frontend** for the page. Each takes 0.84 TC from the account
balance; **Cycles** → **Deposit using Cycle Express** pays that balance
by card. An install needs at least 0.5T cycles on the canister itself,
topped up from the canister's page.

hosty.live's rented canisters (24 hours) are for staging only: a rented
canister is wiped when the rent ends.

### The backend (and a bot)

Build the module you tested locally, from the project root:

```bash
icp build backend           # .icp/cache/artifacts/backend
```

Do not gzip it: the store would serve it with `Content-Encoding: gzip`,
and a browser's `fetch` decompresses that before a client can check
the hash. Then, through the `hosty_*` tools:

1. `hosty_check_backend_canister { canisterId }`. With `ready: true`
   (a deploy session already active, or unattended deploys allowed on
   that canister), skip to step 3.
2. `hosty_request_deploy_session { hours: 1 }`. Relay its `userAction`
   to the user verbatim ("open hosty.live and approve the deploy
   session"), say what you are going to install, and poll
   `hosty_get_deploy_session` until `status: "ACTIVE"`. The approval
   covers every canister the user controls until it expires.
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
   with `verified: true`.

Without an agent, the backend canister's page in hosty.live takes the
same file in its install form, after the same approval.

A bot goes up the same way (`icp build bot`, its own Backend canister),
then lists itself in the game's bot directory: during the deploy
session, `hosty_call_canister` on the bot, method `register`, argument
`(principal "<backend-id>", "<Bot Name>")`, as an update call. An
update call in a session is signed as the user, the bot's controller,
which `register` requires; `unregister` takes
`(principal "<backend-id>")`.

Every later version is steps 1 to 5 again; the canister id stays.

### The frontend

The page finds its backend in the `ic_env` cookie its canister sets,
built from the canister's `PUBLIC_*` environment variables; the Duel
dashboard (section 4) reads the same cookie to find the backend a
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
included (hosty.live applies it as icp-cli does). There is nothing to
deploy from git: `duel-game-core` is a `file:` dependency the
hosty.live build server cannot resolve, so the build always happens on
the user's computer.

**With the agent:**

1. `hosty_check_canister { canisterId }` until it answers `ready:
true`. A created canister needs **Grant agent deploy access** clicked
   once in **Settings**. Its `environment` shows what the page
   publishes now; an `environment.module` of `LEGACY_ASSETS` means the
   canister can publish no cookie at all, and the user first clicks
   **Reset canister** on its page.
2. Unless `environment` already shows `PUBLIC_CANISTER_ID:backend` with
   this backend's id, setting it signs as the user: open a deploy
   session as for the backend (`hosty_request_deploy_session`, relay
   its `userAction`, poll until `ACTIVE`).
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
5. Check the cookie, then open `frontendUrl` and play a round from two
   tabs against the live backend. Gateways cache for up to a minute
   after a deploy.

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

## 3. Route B: everything with icp-cli

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

**Deploy**, from the project root, naming each canister, with the
hosty.live token from section 1 in the environment so the backend's
sync step can put its module into the store:

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
upgrade the same canisters and keep the backend's tables. A canister's
balance shows in `icp canister status <name> -e ic`; topping it up is
cycle.express again, with the canister id as the recipient, or `icp
canister top-up <name> -e ic --amount 1t` from the identity's balance.

A route-B canister moves to route A later without a reinstall: add the
user's hosty.live principal (`hosty_whoami`, or **Settings**) as a
controller (`icp canister settings update <id> -n ic --add-controller
<principal>`), then **Canisters** → **Import canister** in hosty.live.

## 4. List it on the Duel dashboard

The dashboard at https://n6plc-4yaaa-aaaaj-qshia-cai.icp.net/ is where
players find games. The user logs in there (Internet Identity),
registers the frontend by its canister id, with a title, a description
and a banner, and, if hosty.live serves it under a custom domain, that
domain. The dashboard reads the backend from the page's `ic_env`
cookie, checks its `/semantics`, and offers "Make your own frontend"
and "Build a bot" for it to everyone else.
