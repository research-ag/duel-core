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

|                  | 1. Cloud session + hosty.live                                                                  | 2. Own computer + hosty.live              | 3. Own computer + icp-cli                                 |
| ---------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| The agent runs   | in a Claude Code cloud session (claude.ai/code, the Claude app)                                | on the user's computer                    | on the user's computer                                    |
| Builds and tests | icp-cli and mops in the session's VM                                                           | icp-cli and mops on the computer          | icp-cli and mops on the computer                          |
| Who signs        | the user's Internet Identity, approving a hosty.live session                                   | the same                                  | an icp-cli identity, a key on the user's computer         |
| Paid with        | nothing while developing (cloud engine canisters); the hosty.live balance, by card, to go live | the same                                  | cycles bought by card at cycle.express: 2T per canister   |
| Deploys          | `hosty_*` tools from the hosty.live connector                                                  | `hosty_*` tools, or the hosty.live web UI | `icp deploy <name> -e ic`                                 |
| The module store | hosty.live stores every module it installs                                                     | the same                                  | `publish_wasm.sh` uploads it, no token needed             |
| Suits            | anyone, from any device; nothing to install                                                    | a user who already runs a coding agent    | a user who already has an identity and cycles, or scripts |

Setups 1 and 2 are the same route, through hosty.live (section 3);
setup 3 is icp-cli all the way (section 4). Keep every canister of a
project on one route. Either way the backend's module ends up in
hosty.live's module store, where other people's frontends and bots
fetch it by the canister's public module hash (backend README,
"Downloadable wasm"). Setups 1 and 2 need a hosty.live account for
that (section 1); setup 3 needs none.

hosty.live has two kinds of canister, and the route through it uses
both in turn:

- **Cloud engine canisters** are free: no cycles, no card, up to ten
  per user at a time (`hosty_whoami` reports the quota). They are for
  developing and testing: deploy as many versions as you like while the
  game takes shape, at no cost. They are not for going live. hosty.live
  may delete one at any time, and the Duel dashboard refuses to list a
  game whose page or backend runs on one.
- **Mainnet canisters** are bought from the user's hosty.live balance
  (paid by card) and are the user's own: permanent, and what the
  dashboard lists. Going live means buying them and deploying the same
  build there; the addresses change, so the cloud engine ids never go
  into `index.html`, a README or anything public.

A game's canisters talk to each other (the backend asks a bot for its
moves), which works only on one network: a game is either all on the
cloud engine or all on mainnet, never split. A page alone (a frontend
for an existing game) may sit on the cloud engine while it plays a
mainnet backend; a bot may not. On mainnet a bot also sits on its
game backend's subnet: the backend asks it once per action, and a
cross-subnet ask takes seconds where a same-subnet one is quick, so a
game against it crawls. Look the backend's subnet up before creating the
bot's canister (`bot-for-existing-game.md`, step 6). A bot for a live
game is tried out beside a cloud engine copy of that game, or in a
rented mainnet canister (`bot-for-existing-game.md`, step 5).

Going live spends the user's money. Buy a canister or deploy to one
only when the user asks for it, after saying what it costs; the
hosty.live connector in your session is the means, never the
permission. A cloud engine canister costs nothing, so the first copy of
a game that passes its local tests goes there as soon as the user wants
to see it. In setup 3, `icp deploy -e ic` is the user's command to run,
or yours when they say so.

The development loop stays local: `mops test`, a local network (`icp
network start -d`, `icp deploy`) and `frontend/play-test.mjs`, in the
session's VM or on the computer. A cloud engine install is for a build
that passes all three; a mainnet install is for one the user has played
on the cloud engine and wants live.

## 1. A hosty.live account and the connector (setups 1 and 2)

The user, once per Claude account, in the browser:

1. Opens https://claude.ai/customize/connectors → **+ Add** → **Add
   custom connector** and pastes `https://api.hosty.live/mcp`.
2. hosty.live opens: they sign in with Internet Identity (a passkey; no
   password, no email) and approve.

From then on claude.ai, every Claude Code cloud session and Claude Code
on the user's computer signed in with their claude.ai plan have the
`hosty_*` tools. hosty.live lists the connection under **Settings** →
**AI agent access**, where the user can disconnect it; that ends its
deploy sessions until they reconnect in claude.ai. Connecting gives
the agent hosty.live's tools as the user; spending cycles and mainnet
installs still need a deploy session the user approves in the web app
with their passkey.

Nothing is paid while the game runs on cloud engine canisters. Cycles
come in at going live (section 3, "For going live").

On Team and Enterprise plans only an admin can add connectors. Without
one, a cloud session uses an API token instead:
`cloud-session.md`, "Without connectors: an API token". Other MCP
clients and scripts: hosty.live's own guide, https://api.hosty.live/skill,
"Connecting an agent".

## 2. Setup 1: a Claude Code cloud session

The session's environment (network access, the setup script that
installs icp-cli and its local network launcher) and the rules for
working in its VM are in `cloud-session.md`, set up before the first
build. Everything it puts online goes through hosty.live, section 3.

**Deploy sessions from anywhere.** The connector alone lets you use
cloud engine canisters and upload into frontend canisters that are
ready for it. A mainnet create, a top-up, a backend or bot install on
mainnet and a mainnet canister's environment variables need a deploy
session: the user's passkey approval, each time. Say why when they
ask. Before requesting one, tell the user what you are about to
create, install or spend, and pass the same as `purpose` to
`hosty_request_deploy_session`. Show them the `requestCode` from its
answer, and ask them to approve, in the hosty.live web app (on a phone
as well as a computer), the request that shows that code and purpose,
and to decline any other (**Decline and disconnect app** on its card
also disconnects the app that made it). Then call
`hosty_wait_for_deploy_session { sessionId }` right away, and again
while it answers `PENDING`; never wait for the user to say they
approved.

## 3. Setups 1 and 2: everything through hosty.live

On the user's own computer (setup 2), Claude Code signed in with a
claude.ai plan has section 1's connector by itself (`/mcp` lists it).
Otherwise the user connects it once, in a terminal of their own:

```bash
claude mcp add --transport http hosty https://api.hosty.live/mcp
```

then `/mcp` → **hosty** → **Authenticate**, signs in with their
passkey and approves. A server added this way with the same URL hides
the connector in that CLI. Other agents (Cursor, Codex and the like)
take the same URL and open the hosty.live sign-in. Without an agent, every step below has a form
in the hosty.live web app. hosty.live's own guide is its skill
`hosty-live-deploy` (`hosty_get_skill { skill: "hosty-live-deploy" }`,
or https://api.hosty.live/skill), with a REST equivalent of every tool;
`hosty-live-build` says what building for hosty.live takes.

### Canisters

Every canister gets a name the user recognizes in hosty.live: pass
`alias` on every create, "<game name> backend", "<game name> frontend",
"<game name> bot", the same name whether the canister is on the cloud
engine or on mainnet (hosty.live shows the network itself).
`hosty_update_canister { canisterId, alias }` renames one later.

**For developing and testing: the cloud engine, free.** Start with
`hosty_whoami`: its `cloudEngine` says whether this hosty.live has an
engine (`enabled`) and how many of the user's slots are taken (`used`
of `max`, 10 by default). With enough free slots for the whole first
look (two for a backend and its page, three with a bot), no deploy
session, no cycles and no card:

- `hosty_create_canister { network: "cloud", kind: "backend", alias }`
  for the backend and for each bot: created empty.
- `hosty_create_canister { network: "cloud", kind: "frontend", alias }`
  for the page: created with hosty's asset module, ready for uploads.

Tell the user what they are getting: free canisters to test how the
game runs, redeployable as often as the game changes while paying
nothing; hosty.live controls them and may delete them at its
discretion, so they are not guaranteed to run forever, and the Duel
dashboard will not list a game on them. Everything else below (installs,
uploads, environment variables, snapshots, `hosty_call_canister`) works
on them without a deploy session, since hosty.live is their controller.
Cycles, top-ups and `icp`/`dfx` do not apply to them. When the slots
are full, `hosty_delete_canister { canisterId }` frees one; confirm with
the user first, since everything on it is lost. Without an engine
(`enabled: false`), the only online copy is the mainnet one: name the
cost and wait for the user's go-ahead before buying anything.

**For a day on mainnet: a rented canister.** `hosty_rent_canister {
kind, alias }` is a mainnet canister free for 24 hours, one per user,
wiped afterwards (module, state, variables); the user is a controller,
installs need no deploy session, and its first install is a reinstall
(`confirmReinstall: true`). Its one use in these guides is a bot that
must be seen playing the live game before its canister is bought
(`bot-for-existing-game.md`, step 5); for everything else the cloud
engine is better, since it has no clock.

**For going live: mainnet canisters, bought.** They are paid from the
user's hosty.live balance. The user tops it up in hosty.live under
**Cycles**: **Deposit using CyclePay** or **Deposit using Cycle
Express** (both by card), or **Deposit ICP**. Prices: a frontend
canister 0.84 TC (about a dollar), a backend or bot
canister 1.5 TC when the agent creates it (an install needs 0.5T on
the canister itself, after a creation fee of about 0.5T). A whole game
with a bot is about 4 TC. With the user's go-ahead and a deploy session
(section 2, "Deploy sessions from anywhere"):

- `hosty_create_canister { kind: "backend", alias }` for the backend
  and for each bot: created empty, 1.5 TC.
- `hosty_create_canister { kind: "frontend", alias }` for the page:
  created with hosty's asset module, ready for uploads, 0.84 TC.

A balance too low for a create fails with the amount missing and a card
payment link (`buyUrl`): give it to the user, wait until `hosty_whoami`
shows the new balance, retry. An error naming a canister that was
already created is finished with `hosty_import_canister`, never by
creating another one.

By hand, the same is **Canisters** → **Create New Canister**, with
**Cloud engine (free)** or **Mainnet** and **Backend** or **Frontend**;
a mainnet backend then needs a top-up to 0.5T on its own page before
the first install.

Moving a game from the cloud engine to mainnet is the same install and
upload into the new canisters, from the same build; then the page's
`PUBLIC_CANISTER_ID:backend` names the mainnet backend, the bot
registers on it, `index.html`'s canonical, Open Graph and JSON-LD tags
and the README carry the mainnet frontend id, and the cloud engine
copies can be deleted to free their slots.

### The backend (and a bot)

Build the module that passed the local tests, from the project root:

```bash
icp build backend           # .icp/cache/artifacts/backend
```

A gzipped copy (`gzip -k`) installs the same way; the store keeps
whichever file was installed, byte for byte. Then:

1. `hosty_check_backend_canister { canisterId }`. With `ready: true`
   (a cloud engine canister, a deploy session active, or unattended
   deploys allowed on that canister), skip to step 3.
2. On a mainnet canister, `hosty_request_deploy_session { hours: 1,
purpose }` and `hosty_wait_for_deploy_session` until `status:
"ACTIVE"` (section 2, "Deploy sessions from anywhere"). The approval
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
   with `verified: true`. With the frontend built, `cd frontend && node
play-test.mjs <backend-id> --ic` plays whole games against the
   installed backend, on access-code tables.

Without an agent, the backend canister's page in hosty.live takes the
same file in its install form, after the same approval.

A bot goes up the same way (`icp build bot`, its own backend
canister on the same network as the game's backend, and on mainnet on
the same subnet: `hosty_create_canister` creates every mainnet canister
on hosty.live's one subnet,
`c4isl-65rwf-emhk5-5ta5m-ngl73-rgrl3-tcc56-2hkja-4erqd-iivmy-7ae`, so a
bot of a game whose backend is elsewhere goes up with icp-cli and
`--subnet` instead; `bot-for-existing-game.md`, step 6), then lists itself
in the game's bot directory: `hosty_call_canister` on the bot, method
`register`, argument `(principal "<backend-id>", "<Bot Name>")`, with
`update: true`. `register` requires its caller to be the bot's
controller. On a mainnet bot that is the user: call during the deploy
session, which signs as them, and check the reply's `caller` is the
user's principal. On a cloud engine bot it is hosty.live: call without
a session, which signs as hosty's builder, and check `caller` is
`hosty_whoami`'s `builderPrincipal`. `unregister` takes `(principal
"<backend-id>")`. A cloud engine bot registers only on a cloud engine
backend, never on a live game.

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
true`. A mainnet canister created in the web UI needs **Grant agent
   deploy access** clicked once in **Settings**; one created with
   `hosty_create_canister`, and every cloud engine canister, is ready.
   Its `environment` shows what the page publishes now; an
   `environment.module` of `LEGACY_ASSETS` means the canister can
   publish no cookie at all, and the user first clicks **Reset
   canister** on its page.
2. On a mainnet canister, unless `environment` already shows
   `PUBLIC_CANISTER_ID:backend` with this backend's id, setting it
   signs as the user: a deploy session, as for the backend. A cloud
   engine canister needs none.
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
   installed backend. Gateways cache for up to a minute after a deploy.

   ```bash
   curl -sI https://<frontend-id>.icp0.io/ | grep -o 'ID%3Abackend%3D[a-z0-9%D-]*cai'
   ```

A later switch to another backend is `hosty_set_canister_env {
canisterId, set: { "PUBLIC_CANISTER_ID:backend": "<backend-id>" } }`
(in a deploy session on mainnet); it publishes at once, with no upload.

**In the web UI:** open the canister → **Canister environment
variables** → **Add variable**, name `PUBLIC_CANISTER_ID:backend`,
value the backend id → **Save and publish** (signed with the user's
Internet Identity, no deploy session). Then **Deploy** → **ZIP
Upload**, pick `dist.zip`, switch on the already-built option (no
build on the server), output directory `dist`, deploy. The
**Deployments** page follows the upload; the canister's page shows the
URL.

Every later version is another build and upload into the same canister;
the variable stays. The user keeps full control of a mainnet canister
and can attach a custom domain or make it immutable from the web UI.

## 4. Setup 3: everything with icp-cli

Only on the user's own computer, never in a cloud session (`cloud-session.md`).

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

**Deploy**, from the project root, naming each canister:

```bash
icp deploy backend -e ic              # a game's backend
icp deploy frontend -e ic             # its page; sets the ic_env cookie itself
icp deploy bot -e ic --subnet <subnet-id>   # a bot, on its game's subnet (bot-for-existing-game.md)
```

`<subnet-id>` is the backend's, looked up before the bot's first
deploy (later upgrades need no `--subnet`):

```bash
curl -sf https://ic-api.internetcomputer.org/api/v3/canisters/<backend-id> | grep -o '"subnet_id":"[^"]*"'
```

If it fails or prints no `subnet_id`, deploy nothing until the subnet
is known.

Always name what to deploy: a bare `icp deploy -e ic` also creates
every other canister in `icp.yaml` on mainnet, 2T cycles each, and for
a project linked to somebody else's backend it fails on that one. The
backend's sync step (`publish_wasm.sh`) runs by itself after every
install and upgrade: it uploads the module the canister now runs to
the store, naming the canister, which needs no token and has the store
verify it against that canister. When it fails (a network error), the
canister is installed but its
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
balance shows in `icp canister status <name> -e ic`, and a backend's
on its card on the Duel dashboard (section 5), read from its
`/metrics`; topping it up is the dashboard's **Top up** (a card
payment through CyclePay to the canister, by anyone), cycle.express
with the canister id as the recipient, or `icp canister top-up <name>
-e ic --amount 1t` from the identity's balance.

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

The dashboard lists mainnet canisters only. A page on hosty.live's
cloud engine, or one whose cookie names a cloud engine backend, is
refused with a message saying so: the game first moves to bought
canisters (section 3, "Canisters").
