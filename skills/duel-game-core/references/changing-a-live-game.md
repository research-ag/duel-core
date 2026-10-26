# Changing a live game: bots, a leaderboard, anything else

Read this when a game built on duel-game-core is already online and the
user wants something added or changed in it, most often "add bots" or
"add a leaderboard". The change itself is small (the Host template's
BOTS and LEADERBOARD lines, two lines of frontend); the work is finding
what is live, reading the ask right, and making sure the upgrade keeps
the tables.

## 1. Read the ask

The words around bots mean two different pieces of work:

- **Bot support** ("support bots", "let people play against bots",
  "add bots to the backend"): the game's own canisters seat canister
  players. The backend gets the Host's BOTS lines and `BotIface.mo`;
  the page gets the 🤖 dialog. About 50 lines, no new canister.
- **A bot** ("write a bot", "an AI opponent", "an easy and a hard
  bot"): a separate canister that plays, `bot/Bot.mo` +
  `bot/BotLogic.mo` (SKILL.md Step 4, `canister-player-bots.md`). It
  needs bot support on the game first.

Bot support alone shows an empty list ("No bots have registered with
this game yet") until some bot canister calls `register_bot`. When the
request names only support, do only that, then ask whether to write a
bot as well. When the words could mean either, ask before building.

A leaderboard is the Host's LEADERBOARD lines plus one frontend line;
pick the rating first (SKILL.md Step 4, "Leaderboard").

## 2. Find the source and what is live

Start from the repository's `CLAUDE.md` (`templates/CLAUDE.md.template`):
it names the canisters and what each runs. Without one, or with an
empty default branch, look before writing anything:

- `git branch -a`: a cloud session's work lands on `claude/...`
  branches, and a game may never have been merged.
- The backend's canister id: the repo's `CLAUDE.md` or `README.md`, the
  `PUBLIC_CANISTER_ID:backend` the page was uploaded with, or the user.
- What it runs now, by that id, from hosty.live's module store:

  ```bash
  curl -s https://api.hosty.live/modules/canister/<backend-id>
  ```

  `module.candid` is the running interface. `register_bot` and
  `join_table_as_canister` there mean bot support is already on;
  `get_leaderboard`, a leaderboard.

If the source on the default branch does not match that interface,
stop and ask which version is the game's: deploying an older tree over
a newer canister throws away features.

When you are done, write or update the repo's `CLAUDE.md` from the
template, and merge into the default branch (or open a pull request
there, as the user prefers).

## 3. The backend

Turn on the Host template's lines marked BOTS (and LEADERBOARD, when
asked): uncomment every one, replace the `null` each stands next to, and
copy `templates/BotIface.mo.template` to `src/BotIface.mo`. A host
written from an older template has the same pieces in SKILL.md Step 4.
Adding stable fields (`bots`, `leaderboard`) to an actor is a
compatible upgrade; nothing else in the host changes.

The framework's own suites cover asking a bot per move, the retry with
`retryReason`, a rematch held for the bot, and the bot's leave; the
game's own tests stay as they are.

## 4. Check the upgrade keeps the tables

Copy `templates/check-upgrade.mjs.template` to
`frontend/check-upgrade.mjs` (`__HOST_FILE__` is `Host.mo`), then:

```bash
cd frontend && node check-upgrade.mjs <backend-id>
```

It downloads the module the canister runs, compiles `src/Host.mo` with
the project's own moc, and runs `moc --stable-compatible` on the two
stable signatures. Exit 1 prints moc's reason (a stable variable
dropped or changed in type): change the code back, or write an explicit
migration. It also runs `mops check-candid` on the new interface
against the live one and exits 1 when a method is removed or a type
changes incompatibly, which would break frontends and bots other people
built against the old one; the diff it prints is for reading.

Exit 2 means nothing was compared: `src/Host.mo` does not compile, or
the live module carries no `motoko:stable-types` or `candid:service`
section, or it could not be fetched. That is not a pass. Fix the
compile error, or find out why the module is missing (`module.hash` in
the store lookup above), and run it again until it exits 0 or 1.

Exit 0 means the types line up, not that the data survives. Before
deploying, also read every piece of code that runs on the upgrade and
check what it does to stable data: the actor body's top-level
statements and those of the mixins it includes (they run again on
every upgrade; in the template they only re-apply the timeouts, attach
the metrics and start the sweep timer), any migration function, and any
`system func preupgrade`/`postupgrade`. The BOTS and LEADERBOARD lines
add none that touches stable data.

## 5. The page

A page on `start()` turns on the BOTS (and LEADERBOARD) lines of
`app.js.template` and `index.html.template`: `mountBotChallenge` gives
"Add Bot" on the waiting screen, the bot list, the seat choice, the
invite, and the automatic re-invite on a rematch; `mountLeaderboard`
gives the 🏆 overlay whose bot rows challenge too. A UI of its own
drives the same flow through `createBotInviter` (`frontend/README.md`,
"Bots and the leaderboard"). Nothing else on the page changes.

## 6. Check, then deploy

Locally (`icp network start -d`, `icp deploy`): `mops test`, `node
play-test.mjs`, and in the page, "Add Bot" appears while you wait at
your own table, the 🤖 list opens (empty without a registered bot), and
the 🏆 overlay loads. With a bot canister, register it on the local
backend and play it once, then Rematch: the bot is invited back by
itself.

Then, with the user's go-ahead, upgrade the backend (hosty.live: the
same `hosty_prepare_wasm_upload` as the first install, with
`snapshotBeforeUpgrade: true`; icp-cli: `icp deploy backend -e ic`),
then upload the frontend, as `going-live.md` describes. A new bot
canister is created and registered as in SKILL.md Step 4.
