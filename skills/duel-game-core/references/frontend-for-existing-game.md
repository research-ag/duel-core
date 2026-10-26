# A new frontend for a game that is already deployed

Read this when the task is a different client for somebody else's
duel-game-core game: you have the game's address or canister id and a
description of the UI the user wants, and no access to the game's
source. You write no Motoko. The game's backend stays where it is, your
frontend talks to it, and players on your frontend meet players on every
other frontend of that game at the same tables. If your environment
gives you a backend of its own (caffeine.ai does), leave it empty and
unused.

Everything you need comes from the backend canister id:

| What                         | From                                                |
| ---------------------------- | --------------------------------------------------- |
| Rules, `View`, `Action`      | `GET /semantics` on the backend                     |
| Service types (optional)     | hosty.live's module store, by the canister id       |
| A copy of the game to test   | the same module, installed into a canister of yours |
| Client library, UI contracts | this skill (`SKILL.md` Steps 1 and 6, `rich-ui.md`) |

All of it is plain HTTPS and hosty.live. Where you work decides the
rest:

- **A Claude Code cloud session** (claude.ai/code; `going-live.md`,
  section 2, is its setup): icp-cli and mops run in the session's VM,
  so you test against a local copy of the game there (steps 5 and 7),
  and the user, who cannot open anything the VM serves, plays the page
  in a free rented hosty.live canister (step 7).
- **A coding agent on the user's computer**: the same local copy, with
  icp-cli on the computer, and the page on `localhost`.
- **A browser-based builder** (caffeine.ai), which runs no shell: skip
  the steps that say so; the semantics text is sufficient to build
  from.

## 1. Resolve the backend id

Given a backend canister id, use it. Given the game's address (what the
Duel dashboard lists), the page publishes its backend in the `ic_env`
cookie its canister sets (from the `PUBLIC_CANISTER_ID:backend`
environment variable every frontend going live sets on its canister,
`going-live.md`):

```bash
curl -sI <game-url>/ \
  | grep -o 'ID%3Abackend%3D[a-z0-9%D-]*cai' | head -1 \
  | sed 's/.*%3D//; s/%2D/-/g'
```

Empty output means that frontend does not publish its backend; ask the
user for the backend canister id.

```bash
BACKEND=<backend-id>
```

## 2. Read the semantics

```bash
curl -s https://$BACKEND.raw.icp0.io/semantics
```

Plain text, written for a reader without the source: `MODE`
(`simultaneous` — both seats submit every round; `turnBased` — the seat
the rules put on turn submits, possibly several actions per turn),
`SEATS`, `OPTIONS` (what a table's creator picks), the exact Candid of
`View` (what a seat sees of the game) and `Action` with every field
explained, `RULES` (what each action does and what gets it rejected),
`ENDINGS`, and `CLIENT NOTES`. Treat it as the specification. The
Candid service (step 3) names `View`, `Action` and `Options` in
`duel_table`/`duel_submit`/`duel_create_table`, but only `/semantics`
says what they mean.

A 404 lists the paths the backend does serve; fetch any that
`/semantics` refers to (a fixed map, for instance). If `/semantics`
itself is missing, the backend predates this procedure: stop and tell
the user.

## 3. Look up the module

hosty.live's module store keeps every game's module under the
canister's `module_hash`, and looks it up by canister id, with no
account or token:

```bash
curl -s https://api.hosty.live/modules/canister/$BACKEND
```

`found: true` comes with `module`: `module.hash` (the module the
canister runs right now), `module.candid` (the service Candid; save it
as `backend.did`) and `module.downloadUrl`. With the hosty.live MCP
server connected, `hosty_get_module { canisterId: BACKEND }` answers the
same. The lookup allows 20 calls per hour from one address without a
token: make it once and keep the answer.

The Candid confirms `View` and shows which optional features the game
has: `get_leaderboard` (rankings), `list_bots` (challengeable canister
players). You do not generate bindings from it; `@research-ag/duel-game-core/idl.js`
already declares the engine's service, and your plugin supplies `View`
and `Action`. Without it (a builder with no shell), assume both
optional features may exist and let their calls fail quietly
(`.catch(() => [])`). With them, `@research-ag/duel-game-core/bots.js`
is the whole flow: `mountBotChallenge` and `mountLeaderboard` for a
page on `start()`, `createBotInviter` for a UI of its own (the package
README, "Bots and the leaderboard").

`found: false` with a `liveModuleHash` means the module the backend
runs is not in the store at the moment: build from the semantics alone,
and skip every copy of the game: step 5, and step 7's local and staging
copies. Step 7's rented preview page and its access-code tests against
the live backend still apply. With icp-cli, `icp
canister metadata $BACKEND candid:service -n ic > backend.did` reads
the Candid from the canister itself.

## 4. Lay out the project

```
frontend/
  package.json  build.js  play-test.mjs
  src/  index.html  app.js  style.css  <game>-plugin.js
backend.did     # step 3, when found
```

The `frontend/` files come from this skill's templates exactly as for a
new game: `package.json.template`, `build.js.template`, `index.html.template`, `app.js.template`,
`style.css.template`, `play-test.mjs.template`. Get the `@research-ag/duel-game-core` npm package as `SKILL.md`
Step 1 describes (the frontend half only; there is no `mops.toml`).

In a builder with its own project layout (caffeine.ai: React, Vite),
keep its layout and add the `@research-ag/duel-game-core` npm package to it. Never
rewrite the wire protocol yourself.

**Backend id in the frontend.** Read `PUBLIC_CANISTER_ID:backend` from
the `ic_env` cookie when present (the live page once its canister
carries that environment variable, `going-live.md`; a local copy's
page, step 5) and fall back to a backend id hardcoded in one constant
(a page served from `localhost`, a builder's own preview, caffeine.ai).
The constant is `BACKEND` (a rented preview page in a cloud session
reads it too, step 7), or the staging copy's id while testing against
one (step 7). Whenever the page talks to a backend on mainnet,
build the `HttpAgent` with `host: "https://icp0.io"` and no `rootKey`:
`deriveHost()` assumes the backend sits behind the page's own origin,
which is false for a page served from `localhost` or a foreign host.

## 5. A local copy (with icp-cli)

With icp-cli, in a cloud session's VM or on the user's computer, the
game runs on a local network beside the frontend. Skip this step only
in a builder without a shell; step 7's staging copy does the same job
on mainnet.

Download the module and check it against the canister's certified
`module_hash` (icp-cli reads it from the state tree):

```bash
HASH=$(icp canister status $BACKEND -n ic -p --json | sed -n 's/.*"module_hash":"0x\([0-9a-f]*\)".*/\1/p')
curl -sf https://api.hosty.live/modules/$HASH -o backend.wasm &&
  [ "$(shasum -a 256 backend.wasm | cut -d' ' -f1)" = "$HASH" ] &&
  echo "backend.wasm verified"
```

Never pass `--compressed` to curl here: the hash is of the module
exactly as installed, gzipped or not. The two hashes must be equal:
that proves the file is the module the canister runs right now. (In
JavaScript, the client package's `module-store.js` does the same:
`fetchGameModule(BACKEND)`, see its README, "Fetching a game's
module".) An empty `HASH`, a 404 or a mismatch means the module is not
available at the moment: stop and tell the user; do not fall back to
the live canister on your own.

The downloaded wasm becomes a `prebuilt` canister named `backend`
beside your frontend, in an `icp.yaml` at the project root:

```yaml
canisters:
  - name: backend
    recipe:
      type: "@dfinity/prebuilt@v2.1.0"
      configuration:
        path: backend.wasm
        sha256: <the hash, without 0x>
  - name: frontend
    recipe:
      type: "@dfinity/static-site@v0.4.0"
      configuration:
        dir: frontend/dist
        build:
          - cd frontend && npm run build
```

icp-cli checks `backend.wasm` against `sha256` on every build and
refuses a file that does not match. Then, once, from the project root:

```bash
icp canister link backend $BACKEND -e ic
```

It records the live backend's id under the name `backend` for the `ic`
environment only. A local `icp deploy` still creates a fresh copy of
its own; `icp deploy frontend -e ic` later gives the deployed frontend
the live id; and a mistaken bare `icp deploy -e ic` tries to install
into the live canister and fails, since the user is not its controller,
instead of creating a second backend on mainnet. The id lands in
`.icp/data/mappings/ic.ids.json`: keep it in version control (only
`.icp/cache` is build output). Running `link` again is an error
("already registered") unless it carries `--force`.

The canister must be named `backend`: the frontend then finds the local
copy as `PUBLIC_CANISTER_ID:backend` in its own `ic_env` cookie.

## 6. Write the client

Follow `SKILL.md` Step 6, with the semantics text standing in for the
rules module:

- `idlTypes({ IDL })` — translate `VIEW (Candid)`, `ACTION (Candid)`
  and `OPTIONS` literally (`Options` is `IDL.Record({})` when `OPTIONS`
  is `none`). `nat` is `IDL.Nat` (a `bigint` in JS), `opt T` is
  `IDL.Opt(T)` (`[]` or `[value]`), `vec T` is `IDL.Vec(T)`, a variant
  with no payload is `IDL.Null`. One wrong field and every status fails
  to decode, so check it against `backend.did`'s `View` when you have
  it.
- `legal()` and `applyLocal` mirror `RULES`; the backend's own rules
  remain the judge.
- `OPTIONS` other than `none` → `optionChoices()`/`formatOptions()`,
  each entry's `options` being one typed value the text lists.
- Show the opponent's last move the way `CLIENT NOTES` says it can be
  found.

How far to depart from the default screens is the user's description's
call: restyle through `style.css`, replace individual screens through
`start({ screens })`, or build every screen over `createDuelClient()`
(`references/rich-ui.md`). Whatever the UI, it must still let a player
create a table, join one, play, see the result, and rematch or leave —
the lobby and debrief are part of the game.

## 7. Test

Every check below plays both seats: create a table in one, join from
the other, play a whole game to an ending, rematch once, leave once.
Exercise every action the semantics lists and at least one illegal
input (the backend's rejection text should surface, not a crash). A
status that never arrives or a decode error in the console is an
`idlTypes` mismatch.

**Headless, against the local copy (step 5):**

```bash
cd frontend && npm install && npm run build && cd ..
icp network start -d
icp deploy
cd frontend && node play-test.mjs && cd ..
```

`play-test.mjs` (`SKILL.md` Step 7) plays a whole game per
`optionChoices()` entry through your plugin's own buttons, rematches,
leaves and acks; it is your own check, before any human looks. On the
user's computer, `icp deploy` also printed the frontend's local URL:
the user plays there in two browser tabs. The local copy starts empty:
no bots are registered and the leaderboard is blank, so a bot list or a
rankings panel can only be checked for its empty state.

```bash
icp network stop
```

**The user's look, in a cloud session: a rented page.** Nothing the VM
serves reaches the user, so once the play-test passes, the page goes
into a hosty.live rental: free, private to the user, wiped after 24
hours, one per user. It plays the live backend, so every table opened
from it must be access-code protected:

1. `hosty_rent_canister {}` (a frontend canister, ready for uploads; no
   deploy session needed). Its id is `PREVIEW`.
2. Build with the hardcoded constant at `BACKEND`: the rented page's
   cookie names no backend, so the page falls back to it. Then `cd
frontend && npm run build && zip -r dist.zip dist -x "*.map"`.
3. `hosty_prepare_zip_upload { canisterId: PREVIEW, pureAssets: true,
outputDir: "dist" }`, run the `curl` command it returns from
   `frontend/`, and `hosty_wait_for_deployment` until `finished: true`.
4. Give the user `frontendUrl`, saying that it plays the real game:
   create every table with an access code, never an open one, and
   leave when done, so real players are not drawn in. Two browser tabs
   (or a computer and a phone) play both seats.

Each change is another build and upload into `PREVIEW`. When the
rental runs out, rent again; the id changes.

**Against a staging copy (through hosty.live, on the user's
computer):** the game's own module in a rented hosty.live backend
canister, free, private to the user and wiped after 24 hours, for a
user without icp-cli. It needs the user's hosty.live account and its
MCP server connected to your session (`going-live.md`, section 3), and
step 3's `module.hash`:

1. `hosty_rent_canister { kind: "backend" }`. Its canister id is
   `STAGING`. A user holds one rental at a time.
2. `hosty_check_backend_canister { canisterId: STAGING }`; a rental is
   ready without a deploy session.
3. `hosty_install_module { canisterId: STAGING, moduleHash,
confirmReinstall: true }`, then `hosty_wait_for_deployment` until
   `finished: true`. The rented canister still holds hosty.live's page
   module, so the install is a reinstall; a game backend takes no init
   argument.
4. `curl -s https://$STAGING.raw.icp0.io/semantics` answers step 2's
   text, and `(cd frontend && node play-test.mjs $STAGING --ic)` plays
   it, leaving you in the project root.

Set the hardcoded backend constant to `STAGING`, build, and serve
`frontend/dist` from any local web server. The staging copy starts
empty, as the local copy does. Set the constant back to `BACKEND`
before the build that goes online. Without the MCP server, the user
does the same in the web UI: rent a canister, then install into it
with **Install from module store** and the hash.

**Against the live backend (a builder without a shell):** build the
page and serve it from the builder's own preview. Every table you open
is on the real game: always create tables with an access code, never
open ones, and leave them when done. Keep the testing short. Outside a
rented preview page, whenever a copy is available, never point a
development build at the live backend.

## 8. Going live

Building ends at step 7. Before going live, leave the steps in the
project's `README.md`: for hosty.live, `cd frontend && npm run build &&
zip -r dist.zip dist -x "*.map"`, then on the canister's page the
variable `PUBLIC_CANISTER_ID:backend` set to the backend id and the ZIP
upload, or the same through an agent. Then stop: the page goes online
only when the user asks, into a canister they name or one they agree
you create. Create no canister for it on your own; step 7's rental is
the only one you take unasked.

There is no backend of the user's own to deploy: only the page goes
online, by either route of `going-live.md`.

- **Through hosty.live** (section 3, after section 1's account; the
  only route from a cloud session): no cycles and no icp-cli of the
  user's. `hosty_create_canister { kind: "frontend" }` (0.84 TC from
  the hosty.live balance, about a dollar, in a deploy session the user
  approves) or a canister they created in the web UI; the backend id
  goes in as the canister variable `PUBLIC_CANISTER_ID:backend`, with
  the upload (`canisterEnv` on `hosty_prepare_zip_upload`) or on the
  canister's page.
- **With icp-cli** (section 4, the identity and the cycles, on the
  user's own computer only): `icp deploy frontend -e ic`, 2T cycles,
  after step 5's `icp canister link backend $BACKEND -e ic`; the deploy
  sets the environment variable itself.

Without a way to deploy for the user, tell them the steps from the
`README.md` instead.

In a builder with its own "go live" action (caffeine.ai), tell the
user to trigger it instead, and how to read the live page's address
and its frontend canister id afterwards.

The user then registers the new frontend's canister id on the Duel
dashboard as its own entry (`going-live.md`, section 5), with their
own title, description and banner.
