# duel-game-core — generic 2-player session engine + client

Two independent, rules-agnostic packages, both named `duel-game-core`
(one per registry), for building 2-player games on the Internet Computer
— either simultaneous-reveal (both seats act every round) or strictly
alternating-turn (seats take turns in order), chosen per game via
`Spec`'s own `Mode` tag. Neither package knows anything about any
particular game — that's supplied by whoever builds a game on top.

- **`backend/`** — the Motoko mops package (`duel-game-core`): the
  session engine (a multi-table lobby — table creation/discovery/join,
  round submission, debrief, early leave, rematch, idle takeover,
  per-caller status views, all routed to the right table). Its shared
  type surface — `Spec`, `Seat`, `Phase`, `View`, `Err`, `Res`, `Table`,
  `Registry`, and everything else — is defined once in
  `backend/src/types.mo` and re-exported from `backend/src/lib.mo` (the
  package's entry point — import it as `mo:duel-game-core`, no
  subpath), so a host actor names all of them off one import. The actual
  operations live in two sibling modules, each importable by its own
  subpath: `backend/src/table.mo` (`mo:duel-game-core/table`) is the
  low-level, single-table primitive (`Table.new` plus
  `join`/`submit`/`rematch`/`leave`/`reset`/`claimWin`/`ackEnded`/
  `status`/`sweep` on the table it returns); `backend/src/registry.mo`
  (`mo:duel-game-core/registry`) is the multi-table router built on top
  of it (`Registry.new` plus the same eight caller-facing operations,
  routed to the right table, plus `createTable`/`listTables`/`sweep`).
  Any number of tables run independently and simultaneously
  (`TP.Registry`, created with `Registry.new`); a table can be `#open` or
  protected with an access code shared with a friend out of band — either
  way it's browsable and shows who (if anyone) already holds a seat,
  `#open` joinable outright and `#code` joinable only once the caller
  also supplies the matching code. Once a
  player's own move has sat pending against their opponent's silence for
  longer than a second, independent, normally much shorter timeout
  (`claimTimeoutNs`), `claimWin` lets that player optionally end the
  match by claiming the win outright instead of waiting the opponent out
  — never automatic. `Registry`'s own operations
  (`createTable`/`listTables`/`joinTable`/`submit`/`rematch`/`leave`/
  `reset`/`claimWin`/`ackEnded`/`status`/`sweep`) delegate straight into
  the matching `Table` operation — no game logic or legality is
  reimplemented at this layer; a game that genuinely wants exactly one
  fixed board with no lobby of its own can use `Table` directly instead.
  `Registry.attachMetrics(pt)` is a separate, optional call wiring four
  Prometheus-style metrics (games started, active games, rounds per
  game, matchmaking wait time) onto a `mo:promtracker` `Tracker` — see
  `backend/README.md`'s "Metrics" section.
  See [`backend/README.md`](backend/README.md) for the `Spec<S, M>`
  contract a game implements and a full host-actor wiring example.
  `Spec` is tagged by `Mode` (`#simultaneous`/`#alternating`) — a game
  builds exactly one arm; an `#alternating` game's `resolve` takes just
  the one seat currently on turn (the engine tracks whose turn it is on
  its own), and `claimWin` in that mode is restricted to whichever seat
  is currently waiting on the other's turn — see that same README's
  "Alternating-turn games" section, and `examples/checkers/` below for a
  full worked example.
  `backend/src/ws.mo` (`mo:duel-game-core/ws`) is a separate module
  layered on top of `table.mo`/`registry.mo`, never merged into `lib.mo`
  (see the toolchain note below), but MANDATORY, not optional: real-time
  push over `ic-websocket-cdk` — the live transport `frontend/ws.js`
  actually talks to (not an unused reference add-on) — is the ONLY way a
  client can mutate game state at all. None of `Registry`'s
  `createTable`/`joinTable`/`submit`/`rematch`/`leave`/`reset`/
  `claimWin`/`ackEnded` is exposed as a plain Candid method on a host actor; a
  direct update call bypassing `ws.mo` is exactly the race a single,
  ordered WS channel exists to close (two independent update calls have
  no guaranteed relative processing order once both are in flight).
  `status` is the one exception, staying a plain public `query`
  (side-effect-free, no race risk). `ws.mo` also drives the disappearance
  handling a real WS close signal makes possible (ending a game a
  vanished player left mid-round, freeing a table both walked away from
  — see `backend/README.md`'s "Real-time push" section). `backend/src/actor_mixin.mo`
  (`mo:duel-game-core/actor_mixin`) is a fourth module — a Motoko
  `mixin`, `include`d in the host actor as `include
ActorMixin<system>(ws, sweepFunc)`: it supplies the four `ws_*` Candid
  methods (`ws_open`/`ws_close`/`ws_message`/`ws_get_messages`,
  forwarding each straight to the `ws` built from `Ws.attach`) plus the
  idle-sweep timer, so no host actor hand-declares any of the four.
  `backend/src/canister_players.mo` (`mo:duel-game-core/canister_players`)
  is a fifth module, OPTIONAL (unlike `ws.mo`, wiring it is never
  required — a host that never imports it just has no canister-seatable
  players): it lets a CANISTER take a seat and play, using
  a third reserved `sid` namespace (`cp:`, `sidForCanister`, mirroring
  `ws.mo`'s `ii:`/`an:`) derived from `msg.caller` AND the `TableId` of
  the specific board it names — never a client-supplied `sid`, so
  there's nothing to spoof, and never just `msg.caller` alone, so the
  SAME canister principal can hold a live seat at any number of tables
  at once, each one an ordinary, fully independent session as far as
  the engine is concerned (`Registry.peekNextTableId`, a pure read of
  the registry's own id nonce, is what lets `createTable` derive this
  session before the id it needs would otherwise exist). The whole protocol
  is one call: the game canister calls the player canister's own
  `make_move` and treats the reply AS the move (`registry.submit`,
  applied by the caller, never a second inbound entry point a move could
  arrive through) — reusing `Ws.Attached.afterMutation` so a human
  opponent still learns about a canister-driven move in real time, and
  falling silent (letting `claimTimeoutNs`/`idleTimeoutNs` take over,
  same as an unresponsive human) on a trap, an error, or a move still
  illegal after one retry. `settle(now, id)` is what asks a due canister
  seat for one table, claims the win on a stalled WAITING seat's behalf,
  or acks its own finished `#debrief` once nobody's left to still want a
  rematch; a canister-driven mutation calls it on itself directly, and
  `Ws.attach`'s own optional `onSettled` parameter calls the exact same
  `settle` right after every successful HUMAN-driven mutation too (`ws.mo`
  itself needs no game-specific knowledge to do this — it just calls
  whatever hook the host handed it), so a canister opponent is asked
  the instant either side makes it due, with no polling timer for
  either half of that pairing. The one thing nothing ever calls back in
  about on its own is a stalled opponent's silence — `armClaimCheck`,
  a host-supplied hook using `Timer.setTimer`'s own `<system>`
  capability (which is why it's a parameter `canister_players.mo` takes
  rather than something the module does itself, keeping it `<system>`-free
  and interpreter-testable), schedules exactly one precisely-timed wakeup
  back into `settle` for the moment `claimWinAvailable` will turn true —
  the unattended, canister-vs-canister case, where nobody's around to
  click "claim win" themselves, included, since it fires the same way
  regardless of whether the opponent is human or canister.
  `claim_win_as_canister`/`reset_as_canister` additionally let a canister
  PARTICIPANT act the instant it's entitled to rather than wait on that
  wakeup — each takes the `TableId` it means explicitly (the same one
  `create_table_as_canister`/`join_table_as_canister` returned), since a
  canister may be seated at more than one board at once; either way it
  only ever acts on a board the CALLER'S OWN principal is actually
  seated at — a supervising tournament-orchestrator canister resetting
  or claiming a table it isn't itself seated at is out of scope here.
  `settle` also acks a canister seat's own finished `#debrief` —
  a human's frontend does this itself (`leave`/`ackEnded`, on "return to
  lobby") the moment they're not rematching, but a canister seat has no
  such click, so left alone it would stay pinned to that finished table
  (refusing a fresh `joinTable`/`leave`/etc. naming that SAME `tableId`
  — a brand-new `createTable` for an unrelated board is unaffected,
  since that derives its own fresh, independent session instead) until
  the far slower idle-sweep timer eventually clears it; `settle` acks it
  immediately instead, once the OTHER seat is no longer a live
  participant of that SAME debrief either (already acked, or never
  filled) — never cutting short a still-deciding HUMAN partner's own
  rematch window, since their own seat staying unacked is exactly what
  keeps this from firing. When the other seat is ALSO canister-seated
  (nobody around to decide on a rematch at all), both ack unconditionally
  instead of each waiting on the other's own ack first, which would
  otherwise deadlock two canister seats against each other forever. A
  host also folds `sweep` — the slow, full-registry counterpart to
  `settle`, catching whatever it never gets called for (most commonly the
  OTHER seat vanishing without ever sending a mutating request at all) —
  into its own already-mandatory 30s idle-sweep timer, so none of this
  costs a canister-less host anything and none of it needs a dedicated
  timer of its own either.
  `registry.mo`'s `createTableReserving` is a separate, small
  addition alongside plain `createTable`: it seats BOTH sides atomically
  in one call — the creator, and a `reservedFor` session named
  up front — landing the table directly in `#active` with no second
  `joinTable` needed from either side (Flow 2, "eager dual-seat
  assignment," proven against `canister_players.mo` in
  `backend/test/CanisterPlayers.test.mo`; deliberately not wired any
  further than that — see `backend/README.md`'s own note on why a
  human-facing "invite this bot" button is a separate feature).
  `examples/racing`'s and `examples/checkers`'s own `Add Bot` controls
  (see each one's own `CLAUDE.md`) use Flow 1 instead — this call only
  ever seats both sides of a BRAND NEW table atomically, so it
  structurally can't fill an already-staged table's open seat, which is
  what those controls do. See
  `backend/README.md`'s "Canister players" section for the full design
  and worked example.
  `backend/src/canister_players_actor_mixin.mo`
  (`mo:duel-game-core/canister_players_actor_mixin`) is a sixth module,
  layered on `canister_players.mo` the same way `actor_mixin.mo` is
  layered on `ws.mo`: a `mixin` supplying the six `*_as_canister`
  Candid methods (`create_table_as_canister`/`join_table_as_canister`/
  `leave_as_canister`/`ack_ended_as_canister`/`claim_win_as_canister`/
  `reset_as_canister`), `include`d in the host
  actor as `include CanisterPlayersActorMixin(cpAttached)` — no host
  hand-declares any of the six. (There is deliberately no
  `rematch_as_canister`: a canister-vs-canister debrief auto-acks both
  sides unconditionally the moment neither is a live human still
  deciding, so a canister seat never needs to request a rematch itself
  — see `backend/src/canister_players.mo`'s own `Attached` doc.) It's
  optional in exactly the sense
  `canister_players.mo` itself is (a host that never wires
  `CanisterPlayers.attach` never `include`s this either, and pays no
  cost for skipping it), narrower still than that: a host free to hand-roll
  those six forwarding methods itself instead may still do so — this
  mixin exists purely to stop `examples/racing/src/Host.mo` and
  `examples/checkers/src/Host.mo` (and every future game that opts into
  canister players) from re-typing the identical six methods verbatim.
  Unlike `ActorMixin`, it needs no `<system>` capability of its own (none
  of the six methods touches a timer), so it's declared `mixin
(cpAttached : CanisterPlayers.Attached)`, not `mixin <system>(...)`.
  `backend/src/leaderboard.mo` (`mo:duel-game-core/leaderboard`),
  `backend/src/elo.mo` (`mo:duel-game-core/elo`), and
  `backend/src/leaderboard_actor_mixin.mo`
  (`mo:duel-game-core/leaderboard_actor_mixin`) are a seventh, eighth, and
  ninth module, all OPTIONAL, all entirely game-agnostic — the generic
  session engine still knows nothing about ELO or any other scoring
  concept, so none imports `table.mo`/`registry.mo`/`ws.mo`, nor is any
  imported BY those. `leaderboard.mo`'s `Board` is a top-N score board,
  always sorted highest-score-first — there is no "lower is better"
  direction to configure; a game whose own metric runs the other way
  (`examples/racing`'s best lap TIME) converts it to a higher-is-better
  score itself before ever calling in (`3,600,000 - lapMs`, floored at 0,
  one hour of headroom in milliseconds) — `Leaderboard.new(keep,
defaultScore)` (`keep` is a buffer, typically 2x however many entries a
  host actually shows, so a player who drops out of the shown top-N
  doesn't just vanish outright; `defaultScore` is the host's OWN
  starting-score choice for a player with no entry yet — this module
  takes no view on the number, only stores it), `setScore` (unconditional
  overwrite — an ELO rating that can move either direction) vs
  `recordIfBetter` (only overwrites a strict improvement — a
  personal-best metric that should never regress), `scoreOf` (a
  player's own score, or `defaultScore` if they have none — sparing every
  ELO-shaped caller its own `switch` over `get`), and `top(n)` (the
  ranked slice `leaderboard_actor_mixin.mo`'s own `get_leaderboard`
  returns). `elo.mo`'s `Elo.update(ratingA, ratingB, outcome, k)` is the
  standard chess-ELO formula, pure and stateless — any win/lose/draw game
  plugs into it regardless of `Mode` (`examples/007` and
  `examples/checkers` share this exact module despite one being
  `#simultaneous` and the other `#alternating`, since all either needs is
  a `Verdict`) — and deliberately has no starting-rating opinion of its
  own (no `STARTING_RATING` constant): a new player's first rating is the
  HOST's own call, passed straight to `Leaderboard.new`'s `defaultScore`,
  since this module only ever computes a next rating from two given ones,
  never invents a first one. `leaderboard_actor_mixin.mo` supplies
  `get_leaderboard` the same way `actor_mixin.mo` supplies the four
  `ws_*` methods and `canister_players_actor_mixin.mo` supplies the six
  `*_as_canister` ones: `include LeaderboardActorMixin(leaderboard, 25)`
  and a host's actor has the query, with no hand-declared method of its
  own — no `<system>` capability needed, purely read-only (every WRITE
  still happens from the host's own `onGameEnded`/`onGameStarted`
  closures). Both `leaderboard.mo`/`elo.mo` are filled in from a new pair
  of optional hooks on `Ws.attach`: `onGameEnded`
  (`(TableId, SessionId, SessionId, Debrief<S>) -> ()`, fired once per
  game ending — `submit`/`claimWin`/`leave` producing a FRESH `#debrief`
  this exact call, detected via `Debrief.since == now`, the same
  freshness technique the `rounds_per_game` metric's own internal
  bookkeeping already relies on) and `onGameStarted`
  (`(TableId, SessionId, SessionId) -> ()`, fired once a table freshly
  enters `#active` — `Table.Active` carries no `since` of its own to
  compare against `now` directly, so this is inferred instead from the
  one field combination only ever true at creation: `turn == 0`, neither
  seat has a move pending). Both are purely synchronous (no inter-canister
  call to await) and both fire for a canister player's own moves too,
  since `canister_players.mo`'s mutations reuse this SAME `afterMutation`
  — a bot's games are scored exactly like a human's, with no separate
  wiring. `null` for either costs a host nothing, same as every other
  optional hook here; see `backend/README.md`'s "Leaderboard" section for
  the full worked wiring (both the ELO and best-lap shape — `onGameEnded`
  alone, in both cases: `examples/racing` computes its winner's exact
  in-game time straight from `Debrief.turns` and the winning car's own
  `CarState`, needing no wall clock at all — `onGameStarted`'s own worked
  example instead lives in `skills/duel-game-core/SKILL.md`'s
  "Leaderboard" step, for a game whose metric genuinely has no
  from-game-state shortcut and needs real elapsed time) and the
  player-identity note (`Ws.playerKey` normalizes `ii:`/`an:` sids to a
  stable per-player key; a `cp:` canister-player session is deliberately
  per-TABLE, so a host wiring `canister_players.mo` alongside a
  leaderboard special-cases `CanisterPlayers.principalOfCanisterSession`
  itself so one bot's score accumulates across every table it plays).
- **`frontend/`** — the npm package (`duel-game-core`): the matching
  client plumbing (session identity, real-time push, the generic
  multi-table lobby/staging/rematch/busy/debrief screens, Candid IDL
  scaffolding).
  See [`frontend/README.md`](frontend/README.md) for the `GamePlugin`
  contract (Candid types, seat labels, board/action rendering) a game
  implements, and its "Real-time push" section for the required `ws`
  param — there is no plain-polling fallback, `start()` throws without a
  `ws`, and a host actor built on this framework has no plain mutating
  method to poll in the first place. `frontend/ws.js`'s `connectWs()`
  builds a `GatewayWs` (`frontend/ws/gateway-*.js`) that speaks
  `backend/src/ws.mo`'s real `ic-websocket-cdk` protocol directly: each
  browser tab self-registers as its own Gateway via plain Candid
  `ws_open`/`ws_message`/`ws_close` calls (the CDK allows this — no
  pre-registered Gateway principal required), then a timer drives
  `ws_get_messages` — a genuine round-trip poll, not a browser<->canister
  WebSocket (the IC has none), exactly what a real, separate Gateway
  process would also be doing on the client's behalf. `GatewayWs` still
  exposes a WebSocket-SHAPED surface (`onopen`/`onmessage`/`onclose`) to
  its own caller, and the CDK's own sequence-numbered envelopes plus
  keep-alive/close semantics are real, canister-driven state, not a
  client-side illusion — but the transport underneath that surface is
  Candid calls on an interval, so there's no external relay _process_ to
  run, and no genuine browser WebSocket either. A real Gateway-backed
  transport (swapped in under the same `GatewayWs` surface, see
  `frontend/README.md`'s transport-split table) is what a deployment
  actually wanting browser WebSocket semantics needs.
  `frontend/idl.js`'s `makeIdlFactory` also declares `get_leaderboard`
  unconditionally on every actor it builds, same class as `status` — a
  plain read-only `query`, needing no `ws` round-trip, that a game whose
  backend never wires `mo:duel-game-core/leaderboard` simply never calls;
  `frontend/render.js`'s `renderLeaderboard(entries, plugin, opts?)`
  renders the ranked result, calling a new, optional
  `GamePlugin.formatScore(score)` field to turn each entry's raw `score`
  into display text — the default is the plain integer (already correct
  for an ELO rating), and a game whose backend instead stores a converted
  score (`examples/racing`'s best lap time) supplies the inverse of that
  conversion here. `opts.yourSid` (the caller's own `session.sid`) picks
  out and badges that player's own row via the new `playerKeyOf(sid)`
  helper (mirrors `Ws.playerKey` on the backend exactly — strips the
  `ii:`/`an:` prefix down to the bare principal text so it can be
  compared against a `LeaderboardEntry.player` value), so a player can
  find themselves in a long ranked list at a glance. `renderLeaderboard`
  also renders a canister-seated player's own row with a 🤖 icon and its
  `cp:` marker stripped, via two further small exports —
  `isCanisterPlayer(player)`/`displayPlayerId(player)` — same idea as a
  human's own key already carrying no prefix at all (that one's already
  stripped server-side, by `Ws.playerKey`, before a score is ever
  stored; a bot's `cp:` prefix is added back deliberately, by whichever
  `Host.mo` wires canister players, to key it by its own stable
  principal rather than one of its many per-table sids — see
  `backend/README.md`'s "Leaderboard" section's own player-identity
  note). Unlike the
  lobby/staging/debrief chrome, `renderLeaderboard` is never wired into
  `renderStatus`/`renderView` automatically — a leaderboard has no fixed
  place in every game's own layout, so each game calls it wherever its
  own panel lives; all three examples use the same shape, though (an
  icon-only 🏆 toggle, first in the header's own `.session` — before the
  player id — opening a dedicated full-page overlay rather than a small
  inline panel, so the generic chrome's own live status pushes updating
  `#screen` underneath can never clobber it — see `frontend/README.md`'s
  "Leaderboard" section, and each example's own `CLAUDE.md` for where it
  actually put the panel).
- **`backend/test/*.test.mo`** — interpreter-run suites for the engine.
  `Lifecycle.test.mo` walks one long session narrative; `Engine.test.mo`
  drives each entry point in isolation, covering the error variants,
  takeover gates, and status views the narrative never reaches — both
  exercise `table.mo`'s per-table primitive (`Table.new`, then
  `t.join`/`t.submit`/...) directly. `Lobby.test.mo` and
  `LobbyLifecycle.test.mo` do the same for `registry.mo`'s `Registry`
  itself: per-operation unit checks (table creation/discovery/join,
  routing across several live tables at once, garbage collection, id
  non-reuse) and a multi-table narrative (two tables running
  independently and interleaved) respectively. `Hub.test.mo` covers
  `ws.mo`'s `Hub` — the sid<->principal bridge behind the real-time push
  transport — in isolation, against its two maps directly, since the
  full `IcWebSocketCdk` actor machinery isn't exercisable in this
  interpreter harness; the same file also covers `ws.mo`'s other pure,
  actor-machinery-free helpers this same way — `playerKey` (the
  `ii:`/`an:` prefix-stripping leaderboard identity normalizer) and
  `isFreshMatch` (the field-combination check behind the `OnGameStarted`
  hook — turn 0, no move pending on either seat, touched this exact
  call), pulled out of `attach()` for exactly this reason, the same as
  `rematchOpenedLobby` already was. All of the above are plugged into
  `backend/test/FakeGame.mo` — a deliberately trivial throwaway
  `#simultaneous` `Spec` that exists only to exercise the engine; it is
  not a real game and ships no rendering. `Alternating.test.mo` is the
  `#alternating`-mode counterpart to `Engine.test.mo` — turn-order
  enforcement (`Err.#notYourTurn`), immediate single-move resolution,
  and claim-win gated to the waiting seat — plugged into
  `backend/test/FakeTurnGame.mo`, the equally trivial `#alternating`
  counterpart to `FakeGame.mo`; `Registry`'s own routing is mode-agnostic
  and already covered generically by `Lobby.test.mo`/
  `LobbyLifecycle.test.mo`, so there is no separate registry-level
  alternating suite — `Lobby.test.mo` also covers `createTableReserving`
  (Flow 2's atomic dual-seat assignment) on its own, engine-only terms:
  both sides land `#inGame` from one call, rejecting a self-reservation
  and a `reservedFor` session that's already busy elsewhere.
  `CanisterPlayers.test.mo` covers
  `canister_players.mo`'s own orchestration — due-seat detection via
  `Registry.status`, the retry-once-on-illegal-move then silence
  behavior, the in-flight guard clearing correctly, the eager
  bot-vs-bot trigger, `claimWin`/`reset` forwarding, `sweep`'s own
  automatic claim-win once a canister seat's stall turns overdue (a
  fully unattended, canister-vs-canister match, start to finish, with no
  human ever involved), a canister seated via `createTableReserving`
  being due from the very first ordinary `sweep` call with no
  `joinTable` of its own, `sweep`'s own debrief-ack freeing a canister
  seat pinned to a game a HUMAN'S own action just ended (never routed
  through `canister_players.mo` at all) — staying pinned while that human
  partner could still rematch, then freeing the instant they're gone for
  good — the canister-vs-canister case settling both seats'
  debriefs immediately with no partner-vs-partner deadlock — `settle`
  asking a due seat for one specific table rather than scanning the whole
  registry — and `armClaimCheck` getting armed with exactly
  `secondsUntilClaimable` the moment a canister seat becomes the WAITING
  side but isn't yet overdue, verified with a stubbed spy in place of a
  real `Timer.setTimer` (this module needs no `<system>` capability of
  its own to make that possible — see `attach`'s own doc) — against
  `FakeGame.mo` again, with `afterMutation`
  stubbed (a plain call counter) rather than a real `Ws.attach`, same
  caveat `Hub.test.mo` documents for why the full `IcWebSocketCdk` actor
  machinery isn't exercisable here. (Its own `T0` baseline is
  deliberately small, unlike other suites': several of
  `canister_players.mo`'s own ops call `Time.now()` internally —
  playing the host's own role, the same documented exception `ws.mo`/
  `actor_mixin.mo` already are — which under the `moc -r` interpreter is
  a fixed, tiny constant, not real wall time; a `T0` far larger than
  that would make every canister-landed move look artificially,
  arbitrarily "long ago" the moment a later check queries
  `claimWinAvailable` against it.) `Leaderboard.test.mo` and `Elo.test.mo`
  cover `leaderboard.mo`/`elo.mo` directly, with no engine dependency at
  all — a `Board` is a plain mutable record, `Elo.update` a pure
  function, so both are exercised straight against their own module,
  same as `Hub.test.mo`'s own maps: insertion/overwrite/trim-to-`keep`/
  highest-first ordering and `setScore` vs `recordIfBetter`'s differing
  semantics for the former; the zero-sum property (one player's rating
  move is always the other's exact negative), k-factor scaling, and
  favorite/underdog edge cases for the latter. Neither `onGameEnded` nor
  `onGameStarted` firing correctly inside `afterMutation` itself has a
  dedicated suite of its own — that would need the same full
  `IcWebSocketCdk` actor machinery `Hub.test.mo`'s own doc already
  explains isn't exercisable here; `isFreshMatch`'s own unit coverage
  above is the closest a suite gets to that specific wiring. The
  `*.test.mo` suffix is what `mops test`
  discovers — a file named `FooTest.mo` is silently skipped, so keep the
  suffix when adding
  suites.
- **`backend/bench/*.bench.mo`** — `mops bench` suites. `engine.bench.mo`
  measures the engine's own overhead (not any game's `resolve` cost)
  using the same `FakeGame.mo` spec, across `join`+`leave`, a full
  submitted round, and repeated `status` queries.

This repo is the framework the two packages are built from, not a game
itself — `examples/007/`, `examples/racing/`, and `examples/checkers/`
are reference games built on top of it (a pure rules module implementing
`TP.Spec<S, M>` plus a thin host actor for the backend; a `GamePlugin`
plus `index.html` and deploy config for the frontend), kept here to
prove the packages are usable end to end and to give a new game
something concrete to copy — `007` and `racing` are `#simultaneous`,
`checkers` is `#alternating` (standard English draughts; see
`examples/checkers/CLAUDE.md`), so between them every engine mode has a
worked reference. A real game normally lives in its own repo, structured
the same way.
Building one — whether from scratch or by adapting an existing client —
is a whole workflow with its own hard-won lessons: see the
`duel-game-core` skill (`skills/duel-game-core/SKILL.md`) before
starting — it's written for a third party building from nothing but a
rules description, with no other context, and is installable standalone
in that party's own repo (see that file's own header and the root
README's "Building a game" section), but is equally the right starting
point when working in this repo.

`aggregator/` is a different kind of thing entirely: a standalone
product built on this repo's own Motoko/TypeScript tooling — Internet
Identity login, developer profiles, and a public, filterable registry of
games — not part of either `duel-game-core` package and not a game built
on the session engine above. See its own `aggregator/CLAUDE.md`.

## Toolchain

- moc **1.11.2** (mops toolchain, pinned in `backend/mops.toml`) — enough
  to type-check `lib.mo`/`types.mo`/`table.mo`/`registry.mo`/`ws.mo` and
  run every `backend/test/*.test.mo` suite. `actor_mixin.mo`'s top-level
  `mixin <system>(...)` declaration needs a newer moc — `examples/racing`
  pins **1.14.0** for exactly this reason (see its own `CLAUDE.md`'s
  toolchain note); any consumer whose `Host.mo` wires
  `mo:duel-game-core/actor_mixin` needs at least that version even though
  the package itself is developed against 1.11.2.
- The engine (`src/lib.mo`/`types.mo`/`table.mo`/`registry.mo`) is built
  on `core` (mo:core, the current Motoko standard library). Never import
  `mo:base` in any of it — that's the legacy library. Two modules
  additionally depend on one more package each, for different reasons:
  `types.mo` and `registry.mo` unconditionally import `promtracker`
  (`?PT.Counter`/`?PT.Gauge` fields on `Registry`, and
  `Registry.attachMetrics`) — this IS an always-compiled-in dependency,
  but the integration itself is entirely opt-in: a host that never calls
  `attachMetrics` just leaves those fields `null` and pays no other cost
  (see `backend/README.md`'s "Metrics" section). `src/ws.mo` depends on
  `ic-websocket-cdk` (vendored in this repo at
  `backend/src/ic-websocket-cdk/src`, migrated to `mo:core` throughout —
  it has no `mo:base` import left) — confined to that one module so
  `lib.mo`/`table.mo` stay exactly as pure as the architecture rules
  require, NOT because wiring `ws.mo` is optional (every host actor
  built on this package must wire it — see the `backend/` bullet above;
  this is the one respect in which `ws.mo`'s dependency and
  `registry.mo`'s promtracker dependency differ — the module dependency
  is unconditional either way, but only wiring `ws.mo`'s functionality is
  mandatory). `ic-websocket-cdk` in turn depends on the third-party
  `ic-certification` mops package for its Merkle certification tree,
  which still uses `mo:base` internally — genuinely outside this repo's
  control, unlike `ic-websocket-cdk` itself. Any FUTURE module added
  here still needs the same "why is this not in lib.mo" scrutiny before
  it grows a new dependency.
- `bench-helper` is a dev-dependency, used only by `backend/bench/`.
  Benchmarking requires `[toolchain] pocket-ic` and `wasm-opt` pinned in
  `mops.toml` (already done) — `mops bench` fails outright without them.
- `app.js`, `render.js`, `idl.js`, and `ic-env.js` — everything but
  `frontend/ws/gateway-*.js` and `frontend/identity.js` — have no npm
  dependencies at all, full stop: `app.js`'s `start()` takes an
  already-constructed IC `actor` (and a WebSocket-like `ws`, required)
  from its caller (see `frontend/README.md`), so it never hardcodes an
  agent-loading strategy. `frontend/ws.js` builds that `ws` FOR the
  caller — a `GatewayWs` speaking `backend/src/ws.mo`'s real
  `ic-websocket-cdk` protocol, no external relay library, no Gateway URL,
  nothing to load from a CDN — but `gateway-*.js` itself is one
  documented, narrow exception: it depends on `@icp-sdk/core` (Candid
  encode/decode) and `cborg` (CBOR-decoding `ws_get_messages`' certified
  envelope) — see rule 10. `frontend/identity.js` is the second such
  exception: it depends on `@icp-sdk/auth` (Internet Identity's
  `AuthClient`) and `@icp-sdk/core/identity`, confined there for the
  identical reason — a game that never imports it (the default,
  anonymous-only path) pulls in neither dependency; `app.js` only ever
  imports its TYPES (erased at compile time, so no runtime import
  results), never its implementation — see that file's own doc header.
  Don't let a real npm dependency creep into ANY OTHER file in this
  package.

## Build & test

`mops.toml` lives in `backend/`, not the repo root — run all mops/moc
commands from there:

```bash
cd backend
mops install                       # fetches core per mops.toml

# Type-check:
moc --check --package core <path-to-core/src> src/lib.mo

# Run the test suites (interpreter mode; they Debug.print progress and end
# with "ALL ... CHECKS PASSED"; any trap = a FAIL, exit code 1):
mops test                  # both suites
mops test Engine           # one suite — the filter is a path substring
mops test Lifecycle

# Equivalent single-file invocation, if you need raw moc flags:
moc -r --package core <path-to-core/src> test/Engine.test.mo

# Benchmarks (needs [toolchain] pocket-ic / wasm-opt, already pinned):
mops bench
```

```bash
# Frontend (from the repo root): `frontend/` is TypeScript — build first
# (see "After touching anything under frontend/" below), THEN
# syntax/sanity-check the compiled dist/ output the package actually
# ships; there is no bare frontend/app.js etc. any more to check
# directly, and no DOM needed to import the compiled output either:
(cd frontend && npm run build)
node --check frontend/dist/app.js frontend/dist/render.js frontend/dist/idl.js frontend/dist/ic-env.js frontend/dist/ws.js frontend/dist/identity.js frontend/dist/anon-identity.js frontend/dist/ws/gateway-client.js frontend/dist/ws/gateway-transport.js frontend/dist/ws/gateway-protocol.js
```

With mops installed, `<path-to-core/src>` is typically
`.mops/core@<version>/src` (or use `mops toolchain` / `mops test` wiring),
resolved relative to `backend/`.

### After touching anything under `frontend/`: refresh both examples

`frontend/` is a TypeScript package — its source lives in `frontend/src/`
(and `frontend/test/`), but what it actually SHIPS is `frontend/dist/`
(compiled `.js` + `.d.ts`, gitignored, produced by `npm run build`
— see `frontend/package.json`'s `build` script). **Always run `npm run
build` inside `frontend/` first**, before anything below — neither the
fast copy nor a full reinstall picks up a source edit that was never
compiled; `frontend/dist/` is stale (or missing entirely, on a fresh
clone) until you do.

`examples/007/frontend`, `examples/racing/frontend`, and
`examples/checkers/frontend` each depend on
`duel-game-core` as `file:../../../frontend`, with `install-links=true`
in their `.npmrc` — so it's **copied** into their own
`node_modules/duel-game-core`, not symlinked (an asset canister with no
build step needs real files there, not a symlink that may not survive an
asset-sync step). npm treats a `file:` dependency as unchanged whenever
its declared `version` and lockfile entry look the same, so a plain `npm
install` after editing `frontend/` reports "up to date" and silently
serves stale code — do this instead, every time `frontend/` changes,
without waiting to be asked:

**If `frontend/package.json`'s `dependencies` did NOT change** (the
common case — editing a `.ts` file, adding a function): build, then copy
directly, no further npm involved, effectively instant:

```bash
cd frontend && npm run build && cd ..
for ex in examples/007/frontend examples/racing/frontend examples/checkers/frontend; do
  target="$ex/node_modules/duel-game-core"
  rsync -a --delete frontend/dist/ "$target/dist/"
  cp frontend/package.json frontend/style.css frontend/README.md "$target/"
done
```

(This mirrors exactly `frontend/package.json`'s own `files` field — the
same set a real `install-links=true` copy or `npm pack` would produce —
so it never leaks `frontend/src/`/`frontend/test/` source into a
deployed asset canister.) This is enough for `node --check`/a local
`dfx` reload; for `examples/racing`/`examples/checkers`, also re-run
`npm run build` there too (fast, esbuild only — no network) so EACH
ONE'S OWN `dist/` picks up the change.

**If `frontend/package.json`'s `dependencies` DID change** (e.g. a new
package added): the copy above is not enough — the new package itself
still needs fetching into the example's OWN `node_modules`. Do a full
reinstall (after building — see above), and delete `package-lock.json`
too, not just `node_modules/duel-game-core`:

```bash
cd frontend && npm run build && cd ..
cd examples/007/frontend      && rm -rf node_modules package-lock.json && npm install --legacy-peer-deps
cd examples/racing/frontend   && rm -rf node_modules package-lock.json && npm install --legacy-peer-deps
cd examples/checkers/frontend && rm -rf node_modules package-lock.json && npm install --legacy-peer-deps
```

`--legacy-peer-deps` is required for every example now (007 didn't
previously need it): `frontend/package.json`'s own `@icp-sdk/auth`
dependency (added for `identity.js`, see rule 10 below) declares a peer
dependency on `@icp-sdk/core@^5`, one major behind the `@icp-sdk/core@^6.1.0`
this package (and every example) actually use — `identity.ts`'s own actual
surface (`Identity`/`Principal`'s structural methods) is stable across
that skew, but plain `npm install` still refuses to resolve the conflicting
peer ranges without this flag. A plain `npm install` inside `frontend/`
itself (before running its own `npm run build`) needs
`--legacy-peer-deps` for the same reason.

`frontend/package.json` also declares a `prepare` script (`npm run
build`) — npm normally runs a `file:` dependency's `prepare` script the
same way it does a git dependency's, which would make this automatic.
**Don't rely on that here**: both examples' `allow-scripts` gate (see
their own `package.json`'s `allowScripts` / npm's `allow-scripts`
tooling) blocks `duel-game-core`'s `prepare` from actually running on
install — confirmed live: `npm install` in either example completes with
only a warning (`1 package has install scripts not yet covered by
allowScripts`), `dist/` is silently NOT (re)built, and the copy step
happily copies whatever was already sitting in `frontend/dist/` from
before, stale or not. The explicit `npm run build` above is the one step
actually doing the work — run it every time, don't assume `npm install`
alone did it.

**Why the lockfile has to go too** (a real bug hit doing exactly this
for the `@icp-sdk/core`/`cborg` addition to `frontend/ws/gateway-*.js`):
`rm -rf node_modules/duel-game-core && npm install` alone silently
under-installs. The existing `package-lock.json` has a cached entry for
`duel-game-core` recorded from a PREVIOUS install with a DIFFERENT
(often empty) `dependencies` list; npm trusts that cached entry instead
of re-reading `frontend/package.json`'s current one, so the new
sub-dependencies never get resolved at all — no error, just missing
packages. Only a full `node_modules` + lockfile wipe forces npm to
re-resolve from scratch. Verify it worked: `ls
node_modules/@icp-sdk node_modules/cborg` (or whatever the new package
was) should exist afterward, not just `node_modules/duel-game-core`.

## Architecture rules (violating these reintroduces shipped bugs)

1. **Spec is passed per call, never stored.** Function values aren't stable
   types; storing the `Spec` in state would break canister upgrades. Every
   engine entry point takes `spec` as its first parameter.
2. **The engine owns time.** `now : Int` (nanoseconds, `Time.now()` at the
   host) is a parameter everywhere; none of `lib.mo`/`types.mo`/
   `table.mo`/`registry.mo` may import `Time`. This is what makes the
   test suites deterministic. `ws.mo` and `actor_mixin.mo` are the two
   documented exceptions — both play the HOST's role (each calls
   `Time.now()` itself, same as any host actor would, then hands it to
   the engine as a parameter exactly like the plain wiring does); neither
   is part of the engine and must never fold into `lib.mo`.
3. **Rules stay pure.** `init`/`validate`/`resolve` in a game's `Spec`
   must remain pure functions over immutable records. State transitions
   build new records (`{ me with ... }`), never mutate.
4. **`validate` is the only legality gate.** The engine calls it for BOTH
   seats on every submission — a game's UI's disabled buttons are
   cosmetic. Any new rule constraint goes in `validate`, not in the client.
5. **Every phase carries a timestamp** (`since` / `lastActivity`) so idle
   takeover works from any phase — no ghost lobbies.
6. **Rematch is create-then-join.** A rematch request stages a game with
   `reservedFor = partner` — unless `partner` already acked (left) that
   same debrief, in which case `Table.rematchPartner` reserves nobody and
   the seat opens immediately instead of waiting on a partner who's gone
   for good; the partner's own rematch/join pattern-matches that staging.
   Actor message serialization makes simultaneous clicks race-free. Don't
   replace this with a flag-and-poll scheme. The reserved partner isn't
   only able to accept, either: `leave` while `reservedFor == ?session`
   declines it, clearing just the reservation (the requester's own
   staging survives, now open to anyone) — the `#awaitingRematch` view
   carries a `gen` for exactly this call. At the
   `Registry` layer a rematch reuses the SAME `TableId` — it never
   allocates a new table.
7. **No silent endings.** `leave` from an active game produces a shared
   `#aborted` debrief for both players. `claimWin` offers a third,
   entirely optional ending: once a player's own move has sat pending
   against their opponent's silence for longer than `claimTimeoutNs` (a
   separate, normally much shorter clock than `idleTimeoutNs` — checked
   the same `gen`-bound way `submit`/`leave`/`reset` are, and never
   called automatically by `sweep` or anywhere else), that player
   may credit themselves the win (`#claimed seat`) instead of waiting the
   opponent out; declining to click it just leaves the round pending. In
   a `#alternating`-mode game the same rule reads the same way from a
   different angle: only the seat currently NOT on turn (waiting on the
   other's move) may `claimWin` — the on-turn seat gets `#wrongPhase`
   instead, since they're the one holding up the game, not waiting on
   it. An idle takeover of an ACTIVE game
   records evicted players in `lastEnded` so `status` shows `#endedByOther`
   until they `ackEnded`; takeover of an expired DEBRIEF marks them
   pre-acked (they already saw their debrief) — this asymmetry is
   intentional, see LifecycleTest steps 6–7. A `lastEnded` entry nobody's
   plausibly still coming back to ack (a session that will never return,
   most commonly) doesn't wait forever either: `Table.sweep` also prunes
   any entry older than a generous multiple of `idleTimeoutNs`, via
   `Table.pruneEnded`. This matters beyond just that one entry — at the
   `Registry` layer, `gcIfQuiesced` refuses to drop an `#empty` table
   while ANY `lastEnded` entry is still outstanding, so one permanently
   un-acked notice otherwise pins that table's id in the registry (and
   in `listTables`, looking freshly "open" — `waitingSecs == 0` — forever,
   including across later, unrelated, cleanly-finished games on the same
   freed board) for good.
8. **`status` must stay side-effect-free** — a host exposes it as a
   `query`. Lazy idle-reset happens only in mutating calls.
9. **Pending moves are hidden by construction**: `status` exposes only
   Booleans for the opponent's pending move, never the move itself.
10. **The frontend never assumes an agent-loading strategy.** `app.js`'s
    `start()` takes an already-built `actor` (and an already-built `ws`,
    required — there is no plain-polling fallback any more); it doesn't
    import `@icp-sdk/core/agent` or hardcode a CDN, and never will — that
    rule is absolute, not just "no dependencies yet". Dependencies are a
    narrower, deliberate exception: `frontend/ws/gateway-*.js` (the real
    `mo:duel-game-core/ws` client `frontend/ws.js`'s `connectWs()`
    always builds) depends on `@icp-sdk/core` (Candid encode/decode of
    the message content blob) and `cborg` (CBOR-decoding
    `ws_get_messages`' certified envelope) — confined there for the same
    reason `ic-websocket-cdk` is confined to `backend/src/ws.mo`.
    `frontend/identity.js` is a second such exception, for the identical
    reason: it depends on `@icp-sdk/auth` and `@icp-sdk/core/identity` to
    supply Internet Identity login (see `frontend/README.md`'s "Logging
    in with Internet Identity"), and a game that never imports it pulls
    in neither — `app.js` only ever imports its TYPES, erased at compile
    time. `frontend/anon-identity.js` is a third, narrower exception: the
    persisted-keypair anonymous identity `identity.js` re-exports,
    depending only on `@icp-sdk/core/identity` — not `@icp-sdk/auth` — so
    a game that wants a real, non-spoofable identity with no login step
    at all can import only this and skip `identity.js`'s dependency
    entirely. Every OTHER file in this package (`app.js`, `render.js`,
    `idl.js`, `ic-env.js`) stays dependency-free. `start()` itself stays
    exactly as transport-agnostic as before — a caller may still hand it
    any WebSocket-shaped mock (e.g. for tests) instead of a real
    `GatewayWs` — but `session` is now REQUIRED, not optional: every
    legal `sid` is principal-bound (see `backend/README.md`'s "Player
    identity" section), so `start()` has no self-generated fallback left
    to fall back to on its own.
11. **`ws.mo` reimplements no game logic, and is the sole entry point for
    mutation.** Every WebSocket request dispatches to `registry.mo`'s own
    `Registry` operations (`createTable`, `joinTable`, `submit`, ...)
    directly — none of those eight operations is ALSO exposed as a plain
    Candid method on a host actor (only `status` is, being
    side-effect-free). There is no second transport for the same calls to
    (dis)agree with; a game that ever adds a plain mutating Candid method
    alongside `ws.mo` reopens exactly the race this design closes.
    `canister_players.mo`'s own `*_as_canister` Candid methods are a
    narrow, deliberate exception, not a violation: they're reachable
    only under the separate `cp:` sid namespace `ws.mo`'s own
    `isAuthorizedSid` never authenticates (it only ever recognizes
    `ii:`/`an:`) — so no session is EVER claimed by both transports, and
    the race this rule closes (two independent update calls for the
    SAME session with no guaranteed relative order) never reopens.
    `submit` is still never exposed this way even for a `cp:` session —
    a canister player's move only ever arrives as the direct reply to a
    call `canister_players.mo` itself made, never a separately-arriving
    request (see that module's own doc header).
12. **Leave means left.** `status`/`join`/`rematch` all treat a session
    that already acked its own debrief (via `leave`) as no longer a
    participant of it (`activeDebriefSeat`, not plain `seatInDebrief`),
    even while the phase itself legitimately lingers in `#debrief` for
    the still-deciding partner. `leave` itself keeps using plain
    `seatInDebrief` — it must stay idempotently callable to ack in the
    first place. Skipping this gate anywhere it's needed reintroduces a
    real shipped bug: "Return to lobby" showing that player the identical
    debrief screen — with live Rematch/Leave buttons — until the partner
    ALSO left, indistinguishable from the button doing nothing.

## Skills (read before editing)

Two kinds of `SKILL.md` playbook are relevant here, in different places
because only one of them ships to third parties:

- **`skills/`** (repo root, tracked in git, installable standalone via
  `npx skills add research-ag/duel-core --skill <name>`) — the
  duel-game-core-specific playbook:
  - `skills/duel-game-core/SKILL.md` — building a new game (or adapting
    an existing client) on these two packages, from nothing but a
    plain-English rules description: the `Spec<S, M>` design process,
    copy-and-fill templates for every game-specific file, and (in its
    `references/`) the generic-chrome-vs-rich-UI frontend decision and
    lessons learned building `examples/007` and `examples/racing`.
    Covers both backend and frontend — read this one first if that's the
    task, before the Motoko-specific skills below. Written to be
    installed standalone in a game's OWN repo, but equally the right
    starting point when working here.
- **`.agents/skills/`** (local dev setup, not tracked in git — general
  Motoko authoring skills, not specific to this project) — consult these
  when working here, in order of relevance to this package:

- `.agents/skills/motoko-general-style-guidelines/SKILL.md` — naming,
  layout, 2-space indent, 80-char margin, type-annotation rules. House
  style for ALL code in this repo.
- `.agents/skills/motoko-performance-optimizations/SKILL.md` — allocation
  reduction, text construction in blocks, loop shape. NOTE the cardinal
  rule: NEVER call `Array.concat` (or `.concat`) inside a loop — repeated
  concat is O(n²); accumulate in a `mo:core/List` (or VarArray) and
  convert once at the end. (The single `.concat` in `pushAck()` in
  `table.mo` is fine: called once per update, on a list bounded at 2
  elements — do not let that pattern grow.)
- `.agents/skills/motoko-compiler-warnings-fixes/SKILL.md` — M0194/M0244
  fix recipes; fix one warning class at a time, never `_`-rename record
  fields.
- `.agents/skills/motoko-core-code-improvements/SKILL.md` — import
  ordering (core / third-party / local, alphabetical), unused-import
  cleanup. CAUTION: dot notation creates implicit import needs —
  `xs.concat(..)` / `i.toNat()` still require `import Array` / `import
Int` even though the module name no longer appears (they carry
  comments here saying so; don't remove them).
- `.agents/skills/motoko-dot-notation-migration/SKILL.md` — prefer
  `self.func(...)` dot notation for core functions with a `self` first
  parameter (this repo already uses it); factory functions
  (`Array.repeat`, `Blob.fromArray`) must NOT be converted; parenthesize
  before dotting infix results.
- `.agents/skills/motoko-base-to-core-migration/SKILL.md` — base→core API
  map (`.vals()` → `.values()`, `Debug.trap` → `Runtime.trap`, etc.);
  reference if legacy idioms sneak in.
- `.agents/skills/motoko-doc-strings/SKILL.md` — `///` doc-comment format
  for mo-doc, if documenting the public API further.
- `.agents/skills/motoko-mops-package-maintenance/SKILL.md`,
  `.agents/skills/motoko-github-ci-workflow/SKILL.md`,
  `.agents/skills/motoko-benchmarks-generation/SKILL.md` — when
  publishing this package, adding CI, or benchmarking the engine.

### Keeping `skills/` current

`skills/duel-game-core/SKILL.md`, its `templates/`, and its
`references/` are shipped documentation — installed standalone via
`npx skills add research-ag/duel-core --skill duel-game-core` into a
third party's OWN repo, read cold by an agent with none of this repo's
history or this session's context. Whenever a change here touches
anything any of them describes — an engine/`ws.mo`/`ActorMixin` API, a
`GamePlugin`/`app.js`/`ws.js` contract, a build/deploy command, a type
shape a template mirrors, an example game's structure — update the
affected file(s) in the SAME change, not as a follow-up.

Write the affected passage as if authoring it fresh against today's
architecture, never as a patch over yesterday's. Concretely, nothing
under `skills/` may ever contain:

- Before/after framing — "used to be X, now Y", "previously",
  "as of this change", "was renamed from X".
- Removal notices — "X is gone", "no longer exists", "don't use X
  anymore", "deprecated".
- Any other changelog voice ("recently", "this used to require...").

A reader of `skills/*` should never be able to tell an edit happened —
only ever what's true now. A grep for the changed name catches direct
mentions, not a worked example, a template's own inline comment, or a
"why" aside elsewhere in the same file that quietly assumed the old
shape — after changing anything a skill references, re-read the WHOLE
affected file (and its `templates/`) for exactly that kind of
second-order staleness, not just the passage you edited on purpose.

## Conventions

- Tests are plain interpreter scripts (moc -r), not a test framework:
  `ok`/`expectErr` helpers + `Runtime.trap` on violation. Extend in kind.
  (In mo:core, `trap` lives in `Runtime`; `Debug` only has `print`.)
- `msg`, not `label`, for text parameters (`label` is a reserved word).
- Update the affected test suite(s) when touching engine semantics —
  `Lifecycle.test.mo`/`Engine.test.mo` for `table.mo`'s per-table
  primitive, `LobbyLifecycle.test.mo`/`Lobby.test.mo` for `registry.mo`'s
  `Registry` routing; the doc-header in `backend/src/lib.mo` (wiring
  example + design guarantees) must be kept in sync with reality, as
  must both READMEs and `skills/` (see "Keeping `skills/` current" above
  — as clean rewritten documentation, never a changelog-style patch
  note).
