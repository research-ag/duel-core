# A new frontend for a game that is already deployed

Read this when the task is a different client for somebody else's
duel-game-core game: you have a canister id and a description of the UI
the user wants, and no access to the game's source. You write no Motoko.
The game's backend stays where it is, your frontend talks to it, and
players on your frontend meet players on every other frontend of that
game at the same tables.

Everything you need comes from the backend canister id:

| What                         | From                                                |
| ---------------------------- | --------------------------------------------------- |
| Rules, `State`, `Action`     | `GET /semantics` on the backend                     |
| Service types                | the `candid:service` metadata section               |
| The wasm, for a local copy   | the backend's public snapshot                       |
| Client library, UI contracts | this skill (`SKILL.md` Steps 1 and 6, `rich-ui.md`) |

## 1. Resolve the backend id

Given a backend canister id, use it. Given the game's frontend (a
canister id or URL, which is what the Duel dashboard lists), read the
backend id out of the `ic_env` cookie that frontend sets:

```bash
curl -sI https://<frontend-id>.icp0.io/ \
  | grep -o 'ID%3Abackend%3D[a-z0-9%D]*cai' | head -1 \
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
(`simultaneous` — both seats submit every round; `alternating` — the
seat on turn submits), `SEATS`, `VARIANTS`, the exact Candid of `State`
and `Action` with every field explained, `RULES` (what each action does
and what gets it rejected), `ENDINGS`, and `CLIENT NOTES`. Treat it as
the specification. `Action` appears nowhere else: it travels inside
`duel_request`'s blob, so the Candid service does not mention it.

A 404 lists the paths the backend does serve; fetch any that
`/semantics` refers to (a fixed map, for instance). If `/semantics`
itself is missing, the backend predates this procedure: stop and tell
the user.

## 3. Fetch the Candid

```bash
icp canister metadata $BACKEND candid:service -n ic > backend.did
```

It confirms `State` and shows which optional features the game has:
`get_leaderboard` (rankings), `list_bots` (challengeable canister
players). You do not generate bindings from it; `duel-game-core/idl.js`
already declares the engine's service, and your plugin supplies `State`
and `Action`.

## 4. Pull the wasm

```bash
SNAP=$(icp canister snapshot list $BACKEND -n ic -q | head -1)
icp canister snapshot download $BACKEND $SNAP -n ic -o snapshot
cp snapshot/wasm_module.bin backend.wasm
shasum -a 256 backend.wasm
curl -s https://ic-api.internetcomputer.org/api/v3/canisters/$BACKEND \
  | grep -o '"module_hash":"[0-9a-f]*"'
```

The two hashes must be equal: that proves the file is the module the
canister runs right now. Keep `backend.wasm`; delete `snapshot/` (it
also holds the canister's memory, which you have no use for).

No snapshot, a download that is refused, or a hash mismatch means the
backend is not pullable at the moment. Stop and tell the user; do not
test against the live canister instead, since every table you create
there is visible to real players.

## 5. Lay out the project

```
icp.yaml
backend.wasm
backend.did
frontend/
  package.json  .npmrc  build.js
  src/  index.html  app.js  style.css  <game>-plugin.js
```

`icp.yaml` — the pulled wasm as a `pre-built` canister named `backend`,
beside your frontend:

```yaml
canisters:
  - name: backend
    build:
      steps:
        - type: pre-built
          path: backend.wasm
          sha256: <the hash from step 4>
  - name: frontend
    recipe:
      type: "@dfinity/static-site@v0.4.0"
      configuration:
        dir: frontend/dist
        build:
          - cd frontend && npm run build
```

The canister must be named `backend`: the frontend finds it as
`PUBLIC_CANISTER_ID:backend` in its own `ic_env` cookie, locally and on
mainnet alike, so `app.js` never hardcodes an id.

The `frontend/` files come from this skill's templates exactly as for a
new game: `package.json.template`, `.npmrc.template`,
`build.js.template`, `index.html.template`, `app.js.template`,
`style.css.template`. Get the `duel-game-core` npm package as `SKILL.md`
Step 1 describes (the frontend half only; there is no `mops.toml`).

## 6. Write the client

Follow `SKILL.md` Step 6, with the semantics text standing in for the
rules module:

- `idlTypes({ IDL })` — translate `STATE (Candid)` and `ACTION (Candid)`
  literally. `nat` is `IDL.Nat` (a `bigint` in JS), `opt T` is
  `IDL.Opt(T)` (`[]` or `[value]`), `vec T` is `IDL.Vec(T)`, a variant
  with no payload is `IDL.Null`. One wrong field and every status fails
  to decode, so check it against `backend.did`'s `State`.
- `legal()` and `applyLocal` mirror `RULES`; the backend's own `validate`
  remains the judge.
- `VARIANTS` other than `none` → `variantChoices()`/`formatVariant()`,
  each `key` being the variant text listed there.
- Show the opponent's last move the way `CLIENT NOTES` says it can be
  found.

How far to depart from the default screens is the user's description's
call: restyle through `style.css`, replace individual screens through
`start({ screens })`, or build every screen over `createDuelClient()`
(`references/rich-ui.md`). Whatever the UI, it must still let a player
create a table, join one, play, see the result, and rematch or leave —
the lobby and debrief are part of the game.

## 7. Test against the local copy

```bash
cd frontend && npm install --legacy-peer-deps && npm run build && cd ..
icp network start -d
icp deploy
```

`icp deploy` prints the frontend's local URL. Play both seats in two
browser tabs: create a table in one, join from the other, play a whole
game to an ending, rematch once, leave once. Exercise every action the
semantics lists and at least one illegal input (the backend's rejection
text should surface, not a crash). A status that never arrives or a
decode error in the console is an `idlTypes` mismatch.

The local copy starts empty: no bots are registered and the leaderboard
is blank, so a bot list or a rankings panel can only be checked for its
empty state.

```bash
icp network stop
```

## 8. Hand over the mainnet deploy

Deploying spends the user's cycles and is theirs to run. Leave these
commands in the project's `README.md` and in your final message:

```bash
icp canister link backend <backend-id> -e ic   # once: the live game, not a copy
icp deploy frontend -e ic                      # the frontend only
icp canister status frontend -e ic -i          # the new frontend's canister id
```

`link` records the live backend's id for the `ic` environment, so the
deployed frontend's cookie points at the real game. Always name
`frontend` on the deploy line: a bare `icp deploy -e ic` would also try
to install `backend.wasm` over the live backend, which the user does not
control.

The user then registers the new frontend's canister id on the Duel
dashboard as its own entry, with their own title, description and
banner.
