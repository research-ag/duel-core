/// ═══════════════════════════════════════════════════════════════════════════
/// duel-game-core/canister_players — lets a CANISTER take a seat at a
/// `Registry` table and play, against a human or another canister, with no
/// polling and no second inbound entry point for a move to arrive through.
///
/// ── Why this needs no transport of its own ─────────────────────────────────
///
/// `ws.mo` exists because the IC has no native WebSocket, so a browser tab
/// has to fake real-time push by polling over a relay it invents for
/// itself. A canister player needs none of that: two canisters calling each
/// other with `async`/`await` already IS a real, ordered, request-response
/// channel — the primitive the whole IC is built on. This module lets the
/// GAME canister call the PLAYER canister directly and treat the reply as
/// the move (see `notifyAndApply` below) — never the other way around. A
/// one-way "your turn" notice followed by the player canister calling back
/// independently would reopen exactly the unordered-second-channel problem
/// architecture rule 11 closes (two independent update calls have no
/// guaranteed relative processing order once both are in flight); a single
/// `await` whose return value IS the chosen action needs no second inbound
/// entry point at all, so there is nothing new for a stray caller to hit
/// and nothing to spoof — the reply can only ever come from the one
/// principal this module itself decided to call.
///
/// ── Identity: a third `sid` namespace, one per board ────────────────────
///
/// `Table`/`Registry` never look at a `SessionId` beyond comparing it for
/// equality — `ws.mo` already uses that to give a human two non-spoofable
/// identities (`ii:`/`an:`, both of the form `sidFor(prefix, p)`) with no
/// engine change at all. `CP_SID_PREFIX` (`"cp:"`) is a third such
/// namespace, mirroring `Ws.sidFor`'s own shape (see `sidForCanister`'s
/// own doc for why it's a small duplicated one-liner rather than an
/// import of `ws.mo` itself). It's actually simpler here than
/// for a browser: `ws.mo` has to cross-check a client-ASSERTED `sid`
/// against a separately authenticated WebSocket connection, because that
/// transport decouples the two. A plain canister-to-canister Candid call
/// has no such gap — `msg.caller` already IS the authenticated identity —
/// so every entry point below computes its own `cp:` session rather than
/// accepting a client-supplied `sid`. There is nothing to check, because
/// there is nothing to spoof.
///
/// A `Registry` table is still exactly one SESSION's worth of "my one
/// game" — `bySession`'s own 1:1 map is untouched by anything here. What
/// this module doesn't assume any more is that a canister PRINCIPAL maps
/// to only one session: `sidForCanister(p, tableId, complexity)` mints a
/// SEPARATE session per board
/// (`"cp:" # p.toText() # ":" # tableId.toText() # ":" # complexity`), so
/// the same bot canister can hold a live seat at any number of tables at
/// once, each one an ordinary, fully independent session as far as
/// `Table`/`Registry` are concerned. `tableId` is free everywhere except
/// `createTable` itself, where the id doesn't exist yet at the point a
/// session is needed to create it: `Registry.peekNextTableId` (a pure
/// read of the registry's own nonce, as side-effect-free as `status`)
/// supplies it one call early — safe because nothing here `await`s
/// between peeking it and creating the table with it. Every OTHER entry
/// point below that acts on an EXISTING board — `leave`/`ackEnded`/
/// `claimWin`/`reset` — takes `tableId` as an explicit argument instead
/// of trying to infer "my one game": with more than one live board per
/// canister that's ambiguous, so the caller says which board it means,
/// the same way a human's own frontend already knows which table its own
/// screen is showing (the session itself is then looked up on that
/// board, via `sessionAt` — never re-derived, since the complexity
/// segment is only ever chosen at seating time, see below).
/// `principalOfCanisterSession` is `sidForCanister`'s own inverse —
/// recovers the calling canister's principal from a `cp:` session, for a
/// host's own `callBot` closure to know which canister to actually call
/// `make_move` on (see `examples/racing/src/Host.mo`).
///
/// ── Complexity: one bot, several ways to play ────────────────────────────
///
/// A single bot canister may offer more than one way of playing — an
/// "Easy"/"Medium"/"Hard" ladder, a "Rabbit"/"Fox"/"Lion" one, or
/// something that isn't a difficulty at all ("Look-ahead" vs.
/// "Reactive"). Each is a `complexity : Text`, opaque to this module in
/// exactly the way a table's own `variant` is opaque to the engine: never
/// validated or interpreted here, only carried. A bot declares its own
/// list once, at registration (`registerBot`/`BotInfo.complexities` —
/// a constant in the bot's own code, re-registered if it ever changes),
/// and whoever seats the bot at a table picks ONE of them for that
/// session — a human challenger from the "🤖 Bots" dialog, an
/// orchestrator naming a `reservedFor` session for a bot-vs-bot match,
/// or the bot itself on `createTable`/`joinTable`. The pick is the
/// fourth segment of the seat's own session id (above), so it's stored
/// on the table's own phase record for the session's whole life with no
/// separate map to keep stable, and reaches the bot on every ask as
/// `MoveRequest.complexity` (`complexityOfCanisterSession`, the segment's
/// own accessor). A bot with just one way to play needs none of this: it
/// registers with an empty list (normalized to `[DEFAULT_COMPLEXITY]`,
/// `"Default"`) and ignores `req.complexity`. Every complexity is scored
/// separately on a leaderboard — `leaderboardKey(p, complexity)` keys a
/// bot's rating by BOTH — since "CheckersBot (Hard)" and "CheckersBot
/// (Easy)" are genuinely different opponents.
///
/// None of the "ask a due seat for its move"/"settle a finished board"
/// machinery below (`notifyAndApply`, `maybeNotify`, `maybeAckDebrief`,
/// `settle`, `sweep`) needed to change for any of this: each already
/// operates on one specific `TableId` and reads the session `Table`/
/// `Registry` already have stored on THAT table's own phase record,
/// never re-derives one fresh from `caller` — so it was already exactly
/// as multi-board-safe as the engine's own per-table bookkeeping is.
///
/// ── The call/response protocol ──────────────────────────────────────────
///
/// `notifyAndApply` is the whole protocol: build a `T.MoveRequest<S, M>`
/// from the table's OWN current, truthful status (reusing `Registry.status`
/// — never a second, divergent read of `Table`'s internals) plus one extra
/// same-synchronous-call read of the table's own `Active` record for the
/// handful of fields `View` doesn't carry (see `dueRequest`'s own doc),
/// `await` the host-supplied `callBot`, re-read `gen`/`turn` FRESH (not the
/// copies closed over from before that `await` — the table can legitimately
/// change underneath a long-running bot call: the human claims a win,
/// leaves, or gets idle-swept while the bot is still thinking), then apply
/// the reply via `registry.submit` and run the exact same push fan-out
/// `ws.mo` itself runs, so a human opponent's browser learns about a
/// canister-driven move in real time. `settle` decides WHEN to call it —
/// eagerly, right after whichever mutation (canister- or, via
/// `Ws.attach`'s `onSettled`, human-driven) just made a seat due. No
/// polling timer involved; see `backend/README.md`'s "Canister players"
/// section for the full wiring.
///
/// A bot canister can fail in every ordinary way software fails: it traps,
/// it's out of cycles, it's mid-upgrade, it times out, or it just returns
/// an illegal move. None of that needs new machinery — `duel-game-core`
/// already has a complete story for "a seat didn't move"
/// (`claimTimeoutNs`, `idleTimeoutNs`, `#aborted` debriefs), and a
/// misbehaving bot is, from the engine's point of view, indistinguishable
/// from a human who put the phone down. So `notifyAndApply`'s own failure
/// handling is almost trivially small: catch a trapped/errored call or an
/// `#err(#illegalMove _)` result, retry the bot once, and otherwise do
/// NOTHING — let the existing timeout machinery take it from there. The
/// one retry isn't blind: its own `T.MoveRequest<S, M>` carries
/// `retryReason`, the exact rejection text the game's own `validate`
/// returned for the first reply, so a bot that wants to can correct
/// specifically what was wrong (a trapped/errored call has no such text
/// to give — `callBot`'s own `k(null)` never retries at all, see below).
///
/// ── What a bot can build with the request ───────────────────────────────
///
/// Beyond `game`/`seat`/`mode`/`turn` (exactly what `View.#inGame` already
/// hands a human's own screen), `T.MoveRequest<S, M>` also carries
/// `opponent` (the opposing seat's own `SessionId`, stable across every
/// table a HUMAN opponent ever plays at — see `T.MoveRequest`'s own doc
/// for the `cp:` canister-opponent caveat), `opponentLastMove` (their most
/// recently RESOLVED move — never the current round's still-secret one;
/// `null` before they've made one), and `lastRoundDurationNs` (wall-clock
/// nanoseconds the last round/turn took; `null` the same way). None of
/// this is needed for the STATELESS, purely-reactive bots this module's
/// own tests and `examples/racing`/`examples/checkers` ship (a `query`
/// `make_move` that only ever looks at `game`/`seat`/`turn`) — it exists
/// for a bot that wants to remember something ACROSS calls: a move
/// history for the current match (keyed by `(tableId, gen)`, since `gen`
/// bumps on every fresh match including a rematch on the SAME `tableId`
/// — or, equivalently, by watching for `turn == 0`), or a longer-lived
/// model of a specific opponent's own tendencies (keyed by `opponent`,
/// stable across every table they play). Remembering anything across
/// calls means `make_move` can no longer be a `query` method — see
/// `skills/duel-game-core/references/canister-player-bots.md` for the
/// full "simple query bot vs. stateful update bot" design guide, the
/// query/update distinction that forces that choice, and worked examples
/// of both.
///
/// ── A finished game still needs acking ───────────────────────────────────
///
/// A game ending puts BOTH seats in a `#debrief`. A human's own frontend
/// acks it on "return to lobby"; a canister seat has no such click, so
/// `settle` acks it on the seat's behalf once the OTHER seat is no longer
/// a live participant either (already acked, gone, or itself
/// canister-seated) — never cutting short a still-deciding human
/// partner's own rematch window. `sweep` (below) is the slow fallback for
/// whatever `settle` never gets called for at all.
///
/// ── How a host actor wires it ──────────────────────────────────────────
///
///   let cpAttached = CanisterPlayers.attach<Rules.State, Rules.Action>(
///     Rules.spec(), registry, attached.afterMutation, callBot, armClaimCheck,
///   );
///
/// `attached` (`Ws.attach`) and `cpAttached` each need the other's result,
/// so a host resolves the cycle with a small mutable indirection —
/// `armClaimCheck` schedules a `Timer.setTimer` back into `cpAttached.settle`.
/// See `../README.md`'s "Canister players" section for the full worked
/// example (including that indirection), `examples/racing/bot/Bot.mo` for
/// a minimal bot, and `skills/duel-game-core/SKILL.md` for the authoring
/// guide.
/// ═══════════════════════════════════════════════════════════════════════════

import Array "mo:core/Array";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Order "mo:core/Order";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Time "mo:core/Time";

import Registry "./registry";
import Table "./table";
import T "./types";

module {

  /// Reserved `SessionId` namespace for a canister-seated player, bound to
  /// the CALLING canister's own principal — see this module's own doc
  /// header. Never used internally by `Table`/`Registry`, which treat
  /// every `SessionId` as opaque text.
  public let CP_SID_PREFIX : Text = "cp:";

  /// The complexity a bot plays at when nobody picked one — what a bot
  /// registering with no list of its own is listed under, and what an
  /// empty `complexity` argument anywhere in this module normalizes to
  /// (`normalizeComplexity`), so a single-complexity bot and a caller
  /// that doesn't care both land on the same, one, stable session/
  /// leaderboard key. See this module's own doc header.
  public let DEFAULT_COMPLEXITY : Text = "Default";

  public func normalizeComplexity(complexity : Text) : Text = if (complexity == "") DEFAULT_COMPLEXITY else complexity;

  /// This board's own player id for canister `p`, playing at
  /// `complexity` — pure, so it's "issued" for free the first time this
  /// exact triple is ever seen, same as `Ws.sidFor`/`Ws.sidForPrincipal`
  /// (duplicated in miniature here, rather than imported, to keep this
  /// module's own dependency surface to just `core` plus its sibling
  /// `registry.mo`/`types.mo` — see the root `CLAUDE.md`'s toolchain note
  /// on why `ws.mo`'s own dependency on `ic-websocket-cdk` stays confined
  /// to that one module; importing `ws.mo` here for one line would pull
  /// that dependency in transitively for no real reason, since every
  /// actual byte of it is unrelated to canister players). `p` alone is
  /// NOT enough to name a session — see this module's own doc header on
  /// why `tableId` is part of the identity, not just a routing detail,
  /// and why `complexity` rides along as the last segment (free to
  /// contain `:` itself, since nothing after it ever needs splitting
  /// off). `""` normalizes to `DEFAULT_COMPLEXITY`.
  public func sidForCanister(p : Principal.Principal, tableId : T.TableId, complexity : Text) : T.SessionId {
    CP_SID_PREFIX # p.toText() # ":" # tableId.toText() # ":" # normalizeComplexity(complexity);
  };

  // `(principal, complexity)` text segments of a `cp:` session. The
  // complexity is everything after the third `:` (rejoined, so it may
  // itself contain `:`); a session with no such segment reads as
  // `DEFAULT_COMPLEXITY`. Traps on anything that isn't a `cp:` session
  // at all — every call site reaches this only after `isCanisterSession`
  // (or the `#atTable` status this module itself just read) already
  // confirmed it is one, so there's no legitimate case left to return
  // `null` for.
  func parseSession(session : T.SessionId) : (Text, Text) {
    let parts = session.trimStart(#text CP_SID_PREFIX).split(#char ':');
    switch (parts.next(), parts.next()) {
      case (?p, ?_) (p, normalizeComplexity(Text.join(parts, ":")));
      case (_, _) Runtime.trap("malformed cp: session " # session);
    };
  };

  /// `sidForCanister`'s own inverse for its principal segment — recovers
  /// the calling canister's principal from one of its `cp:` sessions. A
  /// host's own `callBot` closure is the one real user (see this module's
  /// own doc header and `examples/racing/src/Host.mo`): it needs to know
  /// which canister to actually call `make_move` on, and the session
  /// `notifyAndApply` hands it is the only place that principal is
  /// recorded.
  public func principalOfCanisterSession(session : T.SessionId) : Principal.Principal = Principal.fromText(parseSession(session).0);

  /// `sidForCanister`'s own inverse for its complexity segment — the
  /// complexity this seat was seated at. What `dueRequest` fills
  /// `MoveRequest.complexity` from, and what `leaderboardKeyOfSession`
  /// scores a bot's own game under.
  public func complexityOfCanisterSession(session : T.SessionId) : Text = parseSession(session).1;

  /// Whether `session` names a canister-seated player under this module's
  /// namespace — a purely cosmetic check for a lobby frontend wanting to
  /// render "vs 🤖" (`TableSummary.p1Session`/`p2Session` already carry the
  /// raw text), and the check `settle`/`sweep` themselves use to decide
  /// which seats are their own responsibility.
  public func isCanisterSession(session : T.SessionId) : Bool = session.startsWith(#text CP_SID_PREFIX);

  /// `"cp:" # p.toText() # ":" # complexity` — the per-PLAYER (not
  /// per-TABLE) key a host uses to record a canister player's own score on
  /// a `mo:duel-game-core/leaderboard` `Board`, since `sidForCanister`'s
  /// own session is per-table (see this module's own doc header) and a
  /// leaderboard needs one stable key per bot instead — per bot AND
  /// complexity, precisely: the same canister playing "Hard" is a
  /// different opponent from it playing "Easy", so each accumulates its
  /// own rating (`frontend/src/render.ts`'s `parseCanisterPlayer` mirrors
  /// this exact shape on the client side, rendering it as
  /// "CheckersBot (Hard)"). Centralized here so `rankedBots` below and
  /// every Host.mo share one definition instead of independent copies.
  public func leaderboardKey(p : Principal.Principal, complexity : Text) : Text = CP_SID_PREFIX # p.toText() # ":" # normalizeComplexity(complexity);

  /// `leaderboardKey` for a live `cp:` session — the one-liner every
  /// Host.mo's own `playerKey` helper special-cases a canister session
  /// through before falling back to `Ws.playerKey` for a human's.
  public func leaderboardKeyOfSession(session : T.SessionId) : Text {
    let (p, complexity) = parseSession(session);
    CP_SID_PREFIX # p # ":" # complexity;
  };

  // ── Bot discovery ────────────────────────────────────────────────────────
  //
  // A canister-seated player only ever gets a live game the way Flow 1
  // (self-join, above) or Flow 2 (`Registry.createTableReserving`)
  // describe: something ALREADY knows the bot's own principal. Before a
  // human can challenge a bot they've never heard of, that gap needs
  // closing — a bot SELF-REGISTERS its own principal/name with the host
  // (via `register_bot`, below, on `canister_players_actor_mixin.mo`),
  // the same non-spoofable `msg.caller` pattern every other entry point in
  // this module already relies on, and a frontend discovers the resulting
  // list via `list_bots`. `BotDirectory` is a plain mutable record, same
  // "module of functions over a passed-in record" shape as `Table`/
  // `Registry`/`Leaderboard.Board` themselves — genuinely stable, no
  // class, no closures.

  /// One bot's own self-reported identity — `principal` is always
  /// `msg.caller` at registration time (see `registerBot`), never
  /// client-supplied, so there's nothing to spoof. `complexities` is the
  /// bot's own declared list, in the order it declared them (a ladder's
  /// order is meaningful — "Easy, Medium, Hard" shouldn't come back
  /// sorted alphabetically), never empty: a bot that declares none is
  /// listed under `[DEFAULT_COMPLEXITY]`. See this module's own doc
  /// header's "Complexity" section.
  public type BotInfo = {
    principal : Principal.Principal;
    name : Text;
    complexities : [Text];
    registeredAt : Int;
  };

  /// One of a bot's complexities joined with its own current rating —
  /// `elo` is `null` only when the host wires no leaderboard at all; a
  /// leaderboard-backed host with a never-played complexity still returns
  /// `?defaultScore` (`Leaderboard.scoreOf`'s own documented fallback),
  /// not `null` — a challenge dialog shows the same starting rating a
  /// human's own first game would.
  public type BotComplexityEntry = {
    complexity : Text;
    elo : ?Int;
  };

  /// `BotInfo` joined with each complexity's current rating
  /// (`rankedBots`, below) — what `list_bots` actually returns to a
  /// frontend's challenge dialog, one entry per BOT (its complexities
  /// nested, still in declared order), so a dialog can group them.
  public type BotEntry = {
    principal : Principal.Principal;
    name : Text;
    complexities : [BotComplexityEntry];
  };

  public type BotDirectory = {
    var bots : Map.Map<Principal.Principal, BotInfo>;
  };

  public func newBotDirectory() : BotDirectory = { var bots = Map.empty() };

  /// Self-registration: `caller` is always `msg.caller` on the host's own
  /// `register_bot` method (never accepted as a parameter), so a bot can
  /// only ever register itself, under its own principal. Idempotent
  /// upsert — a bot re-registering (a rename, a changed complexity list,
  /// or simply re-run after a redeploy) just overwrites its own prior
  /// entry rather than erroring. `complexities` is kept in the order
  /// given, each `""` normalized to `DEFAULT_COMPLEXITY`, duplicates
  /// dropped, and an empty list replaced by `[DEFAULT_COMPLEXITY]` — so a
  /// bot with one way to play declares nothing and is listed under
  /// `"Default"`.
  public func registerBot(d : BotDirectory, caller : Principal.Principal, name : Text, complexities : [Text], now : Int) {
    let seen = List.empty<Text>();
    for (c in complexities.values()) {
      let n = normalizeComplexity(c);
      if (seen.find(func(x : Text) : Bool = x == n) == null) seen.add(n);
    };
    if (seen.isEmpty()) seen.add(DEFAULT_COMPLEXITY);
    d.bots.add(caller, { principal = caller; name; complexities = seen.toArray(); registeredAt = now });
  };

  /// Self-unregistration — same `caller`-is-`msg.caller` discipline as
  /// `registerBot`. A no-op, not an error, if `caller` was never
  /// registered (nothing to spoof, nothing to race).
  public func unregisterBot(d : BotDirectory, caller : Principal.Principal) {
    d.bots.remove(caller);
  };

  /// Every registered bot, in no particular order — `rankedBots` (below)
  /// is what a `list_bots` query actually returns to a frontend.
  public func listBots(d : BotDirectory) : [BotInfo] {
    d.bots.toArray().map<(Principal.Principal, BotInfo), BotInfo>(func((_, v)) = v);
  };

  /// Joins every complexity of every bot with its current rating via a
  /// caller-supplied `scoreOf` (typically `Leaderboard.scoreOf` on some
  /// `Board` under `leaderboardKey(p, complexity)`, partially applied by
  /// `canister_players_actor_mixin.mo`'s own `list_bots`) and sorts the
  /// BOTS highest-rated first — by each one's best-rated complexity —
  /// unrated (`scoreOf` returning `null`, meaning no leaderboard is wired
  /// at all, see `BotComplexityEntry`'s own doc) last, alphabetical by
  /// name as the final tiebreak either way; the complexities WITHIN a bot
  /// keep their declared order. Takes a plain function rather than
  /// importing `leaderboard.mo` directly, so this module's own dependency
  /// surface (see its doc header: `core` plus sibling `registry.mo`/
  /// `types.mo` only) stays untouched, and so this sort is unit-testable
  /// with a trivial stub `scoreOf`.
  public func rankedBots(bots : [BotInfo], scoreOf : (Principal.Principal, Text) -> ?Int) : [BotEntry] {
    let entries = bots.map(
      func(b : BotInfo) : BotEntry = {
        principal = b.principal;
        name = b.name;
        complexities = b.complexities.map(func(c : Text) : BotComplexityEntry = { complexity = c; elo = scoreOf(b.principal, c) });
      }
    );
    func best(e : BotEntry) : ?Int = e.complexities.foldLeft<BotComplexityEntry, ?Int>(
      null,
      func(acc, c) = switch (acc, c.elo) {
        case (?a, ?x) ?Int.max(a, x);
        case (null, x) x;
        case (a, null) a;
      },
    );
    entries.sort(
      func(a : BotEntry, b : BotEntry) : Order.Order {
        switch (best(a), best(b)) {
          case (?x, ?y) {
            if (x == y) Text.compare(a.name, b.name) else Int.compare(y, x);
          };
          case (?_, null) #less;
          case (null, ?_) #greater;
          case (null, null) Text.compare(a.name, b.name);
        };
      }
    );
  };

  /// What a host actor gets back from `attach`: `submit` is deliberately
  /// absent (see this module's own doc header), and `settle`/`sweep` are
  /// the eager and slow-fallback ways to ask/claim/ack a canister seat —
  /// see `maybeSettleBoth` below. There is no `rematch` here: a canister
  /// seat never needs to request one itself — a canister-vs-canister
  /// debrief auto-acks both sides unconditionally the moment neither is a
  /// live human waiting to decide (see `maybeAckDebrief` below), so
  /// nothing is ever left waiting on a canister's own rematch click the
  /// way a human's own "Rematch" button is. `leave`/`ackEnded`/
  /// `claimWin`/`reset` each take `tableId` explicitly — with a canister
  /// potentially seated at several boards at once (see this module's own
  /// doc header), "my one game" is no longer enough to say which one.
  /// `createTable`/`joinTable`'s trailing `Text` is the complexity this
  /// seat plays at (see the doc header's "Complexity" section) — chosen
  /// here, at seating time, and fixed for the session's life.
  public type Attached = {
    createTable : (Principal.Principal, T.Seat, T.TableVisibility, Text, Text) -> async* T.Res<T.TableId>;
    joinTable : (Principal.Principal, T.TableId, T.Seat, ?Text, Text) -> async* T.Res<T.JoinOk>;
    leave : (Principal.Principal, T.TableId, Nat) -> async* T.Res<()>;
    ackEnded : (Principal.Principal, T.TableId) -> async* ();
    claimWin : (Principal.Principal, T.TableId, Nat) -> async* T.Res<()>;
    reset : (Principal.Principal, T.TableId, Nat) -> async* T.Res<()>;
    settle : (Int, T.TableId) -> async* ();
    sweep : (Int) -> async* ();
  };

  /// `armClaimCheck(id, secs)` schedules one future `settle(now, id)` —
  /// a host-supplied hook since only an actor holds `Timer.setTimer`'s
  /// `<system>` capability, which keeps this module `<system>`-free and
  /// testable with a plain stub (see `CanisterPlayers.test.mo`).
  public func attach<S, M>(
    spec : T.Spec<S, M>,
    registry : T.Registry<S, M>,
    afterMutation : (Int, T.SessionId, ?Nat64, ?T.TableId, Bool) -> async* (),
    // Continuation-passing (`k`), not a plain `(...) -> async M` — Motoko
    // rejects `async M` as a type for an unconstrained generic `M` (see
    // this module's own doc header's wiring example). The host's own
    // implementation calls `k(?move)` on success or `k(null)` on a
    // trapped/errored call — the one place able to `try`/`catch` the
    // actual inter-canister call, since `M` is concrete there.
    callBot : (T.SessionId, T.MoveRequest<S, M>, (?M) -> async* ()) -> async* (),
    armClaimCheck : (T.TableId, Nat) -> async* (), // async* so its body can reach `system` — see `ws.mo`'s `onClose`

  ) : Attached {

    // Guards against asking the SAME due seat twice before the first ask
    // resolves. Lost across an upgrade harmlessly (only suppresses a
    // redundant ask).
    let inFlight = Map.empty<Text, ()>();
    func flightKey(id : T.TableId, seat : T.Seat) : Text {
      id.toText() # (switch (seat) { case (#p1) "/p1"; case (#p2) "/p2" });
    };

    /// Builds this session's own `T.MoveRequest<S, M>` from the table's
    /// current, truthful `#inGame` view — never a second, divergent read
    /// of `Table`'s own internals for the fields `View.#inGame` already
    /// carries (`game`/`mode`/`turn`/`gen`). `opponent`/`opponentLastMove`/
    /// `lastRoundDurationNs` aren't part of `View` at all (a human's own
    /// screen has no use for them), so those come from one extra,
    /// same-synchronous-call read of the table's own `Active` record —
    /// safe precisely because nothing `await`s between the two reads,
    /// same reasoning `maybeSettleBoth` below already relies on for its
    /// own direct `registry.tables.get` read. `null` unless `session` is
    /// seated in-game AND it's genuinely their move right now:
    /// `not youSubmitted` is "due to move" in EITHER mode (see
    /// `Table.status`'s own doc for why that one Boolean already means
    /// the right thing for both `#simultaneous` and `#alternating`).
    func dueRequest(now : Int, id : T.TableId, session : T.SessionId) : ?T.MoveRequest<S, M> {
      switch (registry.status(spec, now, session)) {
        case (#atTable { view = #inGame ig }) {
          if (ig.youSubmitted) { null } else {
            switch (registry.tables.get(id)) {
              case null null; // table moved on underneath this read — nothing to build
              case (?t) switch (t.phase) {
                case (#active g) {
                  let (opponent, opponentLastMove) = switch (ig.seat) {
                    case (#p1) (g.p2, g.lastMoveP2);
                    case (#p2) (g.p1, g.lastMoveP1);
                  };
                  ?{
                    tableId = id;
                    seat = ig.seat;
                    game = ig.game;
                    mode = ig.mode;
                    turn = ig.turn;
                    gen = ig.gen;
                    complexity = complexityOfCanisterSession(session);
                    retryReason = null; // a fresh ask, not (yet) a retry — see notifyAndApply
                    opponent;
                    opponentLastMove;
                    lastRoundDurationNs = g.lastRoundDurationNs;
                  };
                };
                case (_) null; // table moved on underneath this read — nothing to build
              };
            };
          };
        };
        case (_) null;
      };
    };

    /// Ask `session` (already confirmed due) for its move, apply it, and
    /// push the result to its human opponent — the full protocol this
    /// module's own doc header describes. Always clears its own in-flight
    /// flag before returning, success or failure alike.
    func notifyAndApply(id : T.TableId, session : T.SessionId, req : T.MoveRequest<S, M>) : async* () {
      let key = flightKey(id, req.seat);
      inFlight.add(key, ());

      // One retry on an illegal move (`triesLeft`), then silence — see
      // this module's own doc header. A trapped/errored call (`callBot`
      // invoking `k(null)`) never retries at all, same as any other
      // failure that isn't specifically an illegal move. The retry's
      // OWN request carries `retryReason`, the exact text `validate`
      // rejected the first reply with, re-read fresh (never `req`'s own
      // stale copy) so the bot can act on specifically why it was wrong
      // instead of just resubmitting blind.
      func tryOnce(triesLeft : Nat, thisReq : T.MoveRequest<S, M>) : async* () {
        await* callBot(
          session,
          thisReq,
          func(maybeMove : ?M) : async* () {
            switch (maybeMove) {
              case null {}; // trapped/errored — treat exactly like silence
              case (?move) {
                let now = Time.now();
                // Re-read gen/turn FRESH — never `req`'s own copies,
                // captured before `callBot`'s own `await` — see this
                // module's doc header.
                switch (dueRequest(now, id, session)) {
                  case null {}; // no longer due at all — table moved on underneath the bot
                  case (?fresh) switch (registry.submit(spec, now, session, fresh.gen, fresh.turn, move)) {
                    case (#ok _) {
                      await* afterMutation(now, session, null, ?id, false);
                      await* maybeSettleBoth(now, id);
                    };
                    case (#err(#illegalMove reason)) {
                      if (triesLeft > 0) {
                        await* tryOnce(triesLeft - 1 : Nat, { fresh with retryReason = ?reason });
                      };
                    };
                    case (#err _) {}; // #stale/#notYourTurn/#wrongPhase/... — table moved on; stop, don't retry
                  };
                };
              };
            };
          },
        );
      };

      await* tryOnce(1, req);
      inFlight.remove(key);
    };

    /// If `session` is due, ask and apply — see `notifyAndApply`. If it's
    /// the WAITING seat and overdue, claim the win on its behalf. If
    /// waiting but not yet overdue, arm `armClaimCheck` for the remaining
    /// `secondsUntilClaimable` instead of polling for it (redundant
    /// re-arming is harmless — each wakeup re-reads truth fresh). No-op
    /// outside `#active`. Shared by every eager trigger and by `sweep`.
    func maybeNotify(now : Int, id : T.TableId, session : T.SessionId) : async* () {
      if (not isCanisterSession(session)) return;
      switch (registry.status(spec, now, session)) {
        case (#atTable { view = #inGame ig }) {
          if (not ig.youSubmitted) {
            if (inFlight.get(flightKey(id, ig.seat)) == null) {
              // Reuses `dueRequest` rather than re-deriving the same
              // request literally here a second time — see its own doc.
              switch (dueRequest(now, id, session)) {
                case (?req) await* notifyAndApply(id, session, req);
                case null {}; // moved on between this check and dueRequest's own re-read — nothing to do
              };
            };
          } else if (ig.claimWinAvailable) {
            switch (registry.claimWin(spec, now, session, ig.gen)) {
              case (#ok _) await* afterMutation(now, session, null, ?id, true);
              case (#err _) {}; // raced/stale by the time this ran — harmless; the next check re-verifies
            };
          } else {
            await* armClaimCheck(id, ig.secondsUntilClaimable);
          };
        };
        case (_) {};
      };
    };

    /// Auto-acks a canister seat's own finished `#debrief` (via
    /// `registry.leave`, same as a human's "return to lobby") once the
    /// OTHER seat is no longer a live participant either — never cutting
    /// short a still-deciding human partner's rematch window. If the
    /// other seat is ALSO canister-seated, both ack unconditionally
    /// instead of deadlocking on each other's ack.
    func maybeAckDebrief(now : Int, id : T.TableId, t : T.Table<S, M>, d : T.Debrief<S>, session : T.SessionId) : async* () {
      if (not isCanisterSession(session)) return;
      if (t.activeDebriefSeat(d, session) == null) return; // already acked — nothing to do
      let partner = if (d.p1 == session) { d.p2 } else { d.p1 };
      let partnerGoneOrCanister = isCanisterSession(partner) or t.activeDebriefSeat(d, partner) == null;
      if (not partnerGoneOrCanister) return;
      switch (registry.leave(now, session, t.gen)) {
        case (#ok _) await* afterMutation(now, session, null, ?id, true);
        case (#err _) {}; // raced/stale by the time this ran — harmless; the next check re-verifies
      };
    };

    /// Checks both seats of `id`'s current phase — exposed to the host as
    /// `settle`; also driven by `sweep`'s full-registry scan.
    func maybeSettleBoth(now : Int, id : T.TableId) : async* () {
      switch (registry.tables.get(id)) {
        case null {};
        case (?t) switch (t.phase) {
          case (#active g) {
            await* maybeNotify(now, id, g.p1);
            await* maybeNotify(now, id, g.p2);
          };
          case (#debrief d) {
            await* maybeAckDebrief(now, id, t, d, d.p1);
            await* maybeAckDebrief(now, id, t, d, d.p2);
          };
          case (_) {};
        };
      };
    };

    /// The session canister `caller` holds at board `id`, if any — read
    /// off the table's own phase record (and its `lastEnded` notices, for
    /// `ackEnded`), where every seated session is already stored in full,
    /// complexity segment included. Only the principal/tableId prefix is
    /// matched, since the complexity was chosen at seating time and a
    /// later `leave`/`claimWin`/`reset`/`ackEnded` has no reason to
    /// repeat it. The first match wins: a canister holding BOTH seats of
    /// one board (possible only by seating itself twice under two
    /// different complexities — no flow in this repo does) resolves to
    /// whichever seat the phase record lists first.
    func sessionAt(caller : Principal.Principal, id : T.TableId) : ?T.SessionId {
      let prefix = CP_SID_PREFIX # caller.toText() # ":" # id.toText() # ":";
      switch (registry.tables.get(id)) {
        case null null;
        case (?t) {
          let seated : [T.SessionId] = switch (t.phase) {
            case (#empty) [];
            case (#staging s) [s.session];
            case (#active g) [g.p1, g.p2];
            case (#debrief d) [d.p1, d.p2];
          };
          let ended = t.lastEnded.flatMap<T.Ended, T.SessionId>(func(e) = [e.p1, e.p2].values());
          seated.concat(ended).find(func(s : T.SessionId) : Bool = s.startsWith(#text prefix));
        };
      };
    };

    {
      // No `await*` between `peekNextTableId` and `createTable` below —
      // see `Registry.peekNextTableId`'s own doc on why that's exactly
      // what keeps this pairing safe.
      createTable = func(caller : Principal.Principal, seat : T.Seat, visibility : T.TableVisibility, variant : Text, complexity : Text) : async* T.Res<T.TableId> {
        let now = Time.now();
        let id = registry.peekNextTableId();
        let session = sidForCanister(caller, id, complexity);
        switch (registry.createTable(spec, now, session, seat, visibility, variant)) {
          case (#ok gotId) {
            await* afterMutation(now, session, null, ?gotId, true);
            #ok(gotId);
          };
          case (#err e) #err(e);
        };
      };

      joinTable = func(caller : Principal.Principal, id : T.TableId, seat : T.Seat, code : ?Text, complexity : Text) : async* T.Res<T.JoinOk> {
        let session = sidForCanister(caller, id, complexity);
        let now = Time.now();
        switch (registry.joinTable(spec, now, session, id, seat, code)) {
          case (#ok j) {
            await* afterMutation(now, session, null, ?id, true);
            // Eager trigger: don't wait for `sweep` if this join settles anything now.
            await* maybeSettleBoth(Time.now(), id);
            #ok(j);
          };
          case (#err e) #err(e);
        };
      };

      // `tableId` says which of this canister's (possibly several) live
      // boards this call means — see this module's own doc header. A
      // `tableId` the caller was never actually seated at has no session
      // of theirs to find (`sessionAt`), so it's `#notSeated` — the same
      // rejection `registry.leave` itself would give.
      leave = func(caller : Principal.Principal, tableId : T.TableId, gen : Nat) : async* T.Res<()> {
        switch (sessionAt(caller, tableId)) {
          case null #err(#notSeated);
          case (?session) {
            let now = Time.now();
            switch (registry.leave(now, session, gen)) {
              case (#ok _) {
                await* afterMutation(now, session, null, ?tableId, true);
                #ok(());
              };
              case (#err e) #err(e);
            };
          };
        };
      };

      ackEnded = func(caller : Principal.Principal, tableId : T.TableId) : async* () {
        switch (sessionAt(caller, tableId)) {
          case null {};
          case (?session) {
            let now = Time.now();
            registry.ackEnded(session);
            await* afterMutation(now, session, null, ?tableId, true);
          };
        };
      };

      // Lets a canister participant act immediately instead of waiting on
      // `armClaimCheck`'s wakeup.
      claimWin = func(caller : Principal.Principal, tableId : T.TableId, gen : Nat) : async* T.Res<()> {
        switch (sessionAt(caller, tableId)) {
          case null #err(#notSeated);
          case (?session) {
            let now = Time.now();
            switch (registry.claimWin(spec, now, session, gen)) {
              case (#ok _) {
                await* afterMutation(now, session, null, ?tableId, true);
                #ok(());
              };
              case (#err e) #err(e);
            };
          };
        };
      };

      reset = func(caller : Principal.Principal, tableId : T.TableId, gen : Nat) : async* T.Res<()> {
        switch (sessionAt(caller, tableId)) {
          case null #err(#notSeated);
          case (?session) {
            let now = Time.now();
            switch (registry.reset(now, session, gen)) {
              case (#ok _) {
                await* afterMutation(now, session, null, ?tableId, true);
                #ok(());
              };
              case (#err e) #err(e);
            };
          };
        };
      };

      settle = maybeSettleBoth;

      sweep = func(now : Int) : async* () {
        // slow full-registry fallback for whatever `settle` misses
        for ((id, _) in registry.tables.toArray().values()) {
          await* maybeSettleBoth(now, id);
        };
      };
    };
  };
};
