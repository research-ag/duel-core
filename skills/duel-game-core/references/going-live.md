# Going live

Read this when something tested locally should be reachable by the
public: a whole game (`SKILL.md` Step 8), a new frontend for an
existing game (`frontend-for-existing-game.md`), or a bot
(`bot-for-existing-game.md`). It is written for a user who may know
nothing about the Internet Computer: follow it with them, one step at a
time, and leave the same steps in the project's `README.md`.

A game is two kinds of canister, put online two different ways:

| What                        | How                                                | Costs                                                    |
| --------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| The backend, a bot (Motoko) | `icp-cli` from the user's computer, paid in cycles | a few dollars of cycles, bought by card at cycle.express |
| The frontend (static files) | hosty.live, from its web UI or through its MCP     | about a dollar of cycles, paid by card on hosty.live     |

Going live spends the user's money. Run a deploy only when the user
asks for it. A hosty.live MCP server connected to your session is that
go-ahead for the frontend; the backend's `icp deploy` is the user's
command to run, or yours when they say so.

## 1. The backend (and a bot): icp-cli and cycles

Skip this section for a frontend to an existing game: its backend is
somebody else's and already live.

**An identity.** `icp-cli` signs every call with a key it keeps on the
user's computer. Once, with a name of the user's choosing:

```bash
icp identity new my-game
icp identity default my-game
icp identity principal        # the long xxxxx-...-xxx address: the user's principal
```

That key is what makes the user the canister's controller: the only one
who can upgrade or delete it. `icp identity export my-game` prints
the key; the user should keep a copy somewhere safe.

**Cycles.** Canisters pay for their own computation and storage in
cycles, prepaid. Creating one through `icp deploy` takes 2T cycles off
the identity's balance by default and the canister keeps running on
them for a long time; buy 3T (a few dollars) for one canister, 5T for
a backend and a bot. The simplest way is by card at
https://cycle.express/: paste the principal that `icp identity
principal` printed into its recipient field, pay with Stripe. Then:

```bash
icp cycles balance -n ic
```

**Deploy.** From the project root, naming the canister:

```bash
icp deploy backend -e ic              # a game's backend
icp deploy bot -e ic                  # a bot (bot-for-existing-game.md)
```

Always name what to deploy: a bare `icp deploy -e ic` also creates
every other canister in `icp.yaml` on mainnet, 2T cycles each, and for
a project linked to somebody else's backend it fails on that one. The
backend's sync step (`publish_wasm.sh`) runs by itself after the
install, so the canister serves its own wasm at `/wasm` from the first
deploy on. Then:

```bash
icp canister status backend -e ic -i  # the backend's canister id: write it down
curl https://<backend-id>.raw.icp0.io/semantics
```

Later deploys of the same project upgrade the same canister and keep
its tables. The canister's balance shows in `icp canister status
backend -e ic`; topping it up is cycle.express again, with the
canister id as the recipient, or `icp canister top-up backend -e ic
--amount 1t` from the identity's balance.

## 2. The frontend: hosty.live

hosty.live (https://hosty.live/) takes a folder of built static files
and serves it from an asset canister of its own at
`https://<frontend-id>.icp0.io/`. A login with Internet Identity (a
passkey; no password, no email), a canister created there (0.84 TC
from an account balance topped up by card: about a dollar at the time
of writing), and either its web UI or, for an AI coding agent, its MCP
server; icp-cli is used once, to name the backend, by the agent. The
user keeps full control of the canister and can later attach a custom
domain or make it immutable from the web UI.

hosty.live also rents a free canister for 24 hours, but it is of no use
for a duel frontend: hosty.live blocks controller changes on a rented
canister, so the step below cannot be done on it and the page would
not find its backend. Always use a created canister.

### Point the hosted canister at the backend

The page finds its backend in the `ic_env` cookie its canister sets,
built from the canister's `PUBLIC_*` environment variables (what `icp
deploy` sets on a frontend it creates). On a hosty.live canister that
one variable is set with icp-cli, once per canister, by the identity
from section 1 or a fresh one (`icp identity new`; no cycles are
involved). The user does the browser half, you run the command:

1. The user, in hosty.live: open the canister → **Transfer Canister
   Ownership** → **Add Controller**, pasting the principal that `icp
identity principal` prints. Every other controller stays.
2. You, from any directory:

   ```bash
   icp canister settings update <frontend-id> -n ic \
     --add-environment-variable PUBLIC_CANISTER_ID:backend=<backend-id>
   ```

   A "not a controller" error means step 1 has not happened yet.

The asset canister refreshes the cookie at the next upload, so do this
before the first deploy into that canister; a variable set afterwards
takes effect with the next upload. Check on the live page:

```bash
curl -sI https://<frontend-id>.icp0.io/ | grep -o 'ID%3Abackend%3D[a-z0-9%D-]*cai'
```

The Duel dashboard (step 3) reads the same cookie to find the backend
a listed page plays. Then build:

```bash
cd frontend && npm run build && cd ..
```

`frontend/dist/` is what goes online: `index.html`, `app.js`, the two
stylesheets, and whatever else `build.js` copies.

### Route A: through the MCP server (an AI coding agent)

The user, once, in the browser:

1. Sign in at https://hosty.live/ (Internet Identity).
2. **Settings** → **AI agent access** → name the token (say, "Claude
   Code on my laptop") → create. The page shows the token (`hl_...`)
   once, and next to it the one-line command that connects Claude
   Code to hosty.live:

   ```bash
   claude mcp add --transport http hosty https://api.hosty.live/mcp --header "Authorization: Bearer hl_..."
   ```

   (and the equivalent JSON for Cursor, Windsurf and other MCP
   clients). The token is a password to the user's canisters: revoke
   it on the same page when done.

3. Restart the agent session so the `hosty_*` tools appear.

Then the agent does the rest, in this order (the server's own guide is
https://api.hosty.live/skill; the MCP resource `hosty://skill` is the
same text):

1. `hosty_whoami` — confirms the token and lists the user's canisters.
2. The canister the user created (**Canisters** → **Create New
   Canister**), picked from `hosty_list_canisters`; never
   `hosty_rent_canister` (above).
3. `hosty_check_canister { canisterId }` until it answers `ready:
true`. A created canister needs **Grant agent deploy access** clicked
   once in **Settings**.
4. The environment variable (above): ask the user for the controller
   click, run the command (`hosty_check_canister` does not know about
   it). Build, then from `frontend/`:

   ```bash
   zip -r dist.zip dist -x "*.map"
   ```

5. `hosty_prepare_zip_upload { canisterId, pureAssets: true, outputDir:
"dist" }` returns a `curl` command with a 15-minute upload token.
   Run it from `frontend/`. Its JSON answer carries the deployment
   `id`.
6. `hosty_wait_for_deployment { deploymentId }` until `finished: true`,
   again if it is not. On `SUCCESS` the answer carries `frontendUrl`;
   on `FAILED`, `statusReason` and `logsTail` say why.
7. Open `frontendUrl` and play a round from two tabs against the live
   backend. Gateways cache for up to a minute after a deploy.

Every later deploy is steps 4 to 7 again. There is nothing to deploy
from git: `duel-game-core` is a `file:` dependency the hosty.live build
server cannot resolve, so the build always happens on the user's
computer.

### Route B: through the web UI (no agent)

1. Sign in at https://hosty.live/.
2. **Canisters** → **Create New Canister** (0.84 TC from the account's
   cycles balance; **Cycles** → **Deposit using Cycle Express** pays
   that balance by card).
3. The environment variable (above), then open the canister →
   **Deploy** → **ZIP Upload**. Zip the built
   `frontend/dist` folder, switch on the already-built option (no
   build on the server), output directory `dist`, deploy. The
   **Deployments** page follows the upload; the canister's page
   shows the URL.

### Later changes

Every later version is another upload into the same canister (route A
steps 4 to 7, or route B step 3); the environment variable stays.

A frontend can also go through `icp-cli` instead (`icp deploy
frontend -e ic`, 2T cycles from the identity's balance), which sets the
`ic_env` cookie itself; nothing else changes.

## 3. List it on the Duel dashboard

The dashboard at https://n6plc-4yaaa-aaaaj-qshia-cai.icp.net/ is where
players find games. The user logs in there (Internet Identity),
registers the frontend by its canister id (`<frontend-id>` from
hosty.live's canister page or `hosty_list_canisters`), with a title, a
description and a banner, and, if hosty.live serves it under a custom
domain, that domain. The dashboard reads the backend from the page's
`ic_env` cookie, checks its `/semantics`, and offers "Make your own
frontend" and "Build a bot" for it to everyone else.
