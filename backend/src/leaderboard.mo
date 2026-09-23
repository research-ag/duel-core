/// ═══════════════════════════════════════════════════════════════════════════
/// duel-game-core/leaderboard — a generic, optional top-N score board.
///
/// Knows nothing about ELO, verdicts, lap times, or any other game concept
/// — just a `Text` player key and an `Int` score, kept sorted with the
/// HIGHEST score first, always (there is no "lower is better" board: a
/// game whose own metric runs the other way, e.g. `examples/racing`'s best
/// lap time, converts it to a higher-is-better score itself before ever
/// calling in here — see `../README.md`'s "Leaderboard" section for the
/// worked example). Layered on top of nothing but `core`: no dependency on
/// `table.mo`/`registry.mo`/`ws.mo`, and neither of those depends on this
/// either — a host wires it entirely on its own, from inside the
/// `Ws.OnGameEnded` hook `ws.mo` calls once per game that ends.
///
/// A `Board` is a plain mutable record — the same "module of functions
/// over a passed-in record" shape as `Table`/`Registry` themselves, so a
/// host's own field (`leaderboard : Leaderboard.Board`) is genuinely
/// stable: no class, no closures, survives a canister upgrade like any
/// other plain data.
///
/// `keep` is the board's own buffer size — typically 2x however many
/// entries a host actually wants to show (`top`'s own `n`), so that a
/// player dropping out of the shown range still has their score sitting
/// in the buffer, ready to reappear the moment someone above them drops
/// further, without needing a full recompute from history. Nothing about
/// this module hardcodes 25 or 50; both are just the numbers a host picks
/// when it calls `new`/`top`.
/// ═══════════════════════════════════════════════════════════════════════════

import Array "mo:core/Array";
import Int "mo:core/Int";
import Order "mo:core/Order";

module {

  /// One player's current best/latest score. `updatedAt` is whatever
  /// `now` the host passed to the call that last touched this entry — the
  /// same host-owned clock every other stable field in this package is
  /// timestamped with (see the root `CLAUDE.md`'s architecture rule 2:
  /// `now` is always a caller-supplied parameter, never read here).
  public type Entry = { player : Text; score : Int; updatedAt : Int };

  /// `entries` is always kept sorted highest-score-first and trimmed to
  /// at most `keep` long — every function below maintains both invariants,
  /// so nothing outside this module needs to re-sort or re-trim.
  /// `defaultScore` is what `scoreOf` (below) returns for a player with no
  /// entry yet — this module takes no view on what that number should be
  /// (an ELO rating's own "unrated" convention, a personal-best metric's
  /// own "nothing recorded" placeholder, ...); the host supplies it once,
  /// here, at construction.
  public type Board = {
    keep : Nat;
    defaultScore : Int;
    var entries : [Entry];
  };

  public func new(keep : Nat, defaultScore : Int) : Board = {
    keep;
    defaultScore;
    var entries = [];
  };

  func indexOf(b : Board, player : Text) : ?Nat {
    b.entries.findIndex(func(e : Entry) : Bool = e.player == player);
  };

  // Re-sorts and re-trims after replacing (or adding) one entry. `keep` is
  // small (tens, not thousands) by construction — see this module's own
  // doc header — so a full re-sort on every write is trivially cheap;
  // there's no reason to reach for an incremental insertion here.
  func upsert(b : Board, e : Entry) {
    let withoutOld = b.entries.filter(func(x : Entry) : Bool = x.player != e.player);
    let merged = Array.concat(withoutOld, [e]);
    let sorted = merged.sort(func(a : Entry, b : Entry) : Order.Order = Int.compare(b.score, a.score));
    b.entries := if (sorted.size() > b.keep) sorted.sliceToArray(0, b.keep) else sorted;
  };

  /// Unconditionally sets `player`'s score, replacing whatever was there
  /// before — for a metric that can move either direction after every
  /// game, like an ELO rating (`mo:duel-game-core/elo`), where the LATEST
  /// value is always the current truth, not just whichever was best.
  public func setScore(b : Board, player : Text, score : Int, now : Int) {
    upsert(b, { player; score; updatedAt = now });
  };

  /// Only overwrites `player`'s entry if `score` is strictly higher than
  /// whatever's on record — for a personal-best metric, like a converted
  /// lap time, that should never regress. Returns whether anything
  /// changed (a new personal best, or a first-ever entry that made the
  /// cut), so a caller that cares can tell a real improvement apart from
  /// a no-op write. A player with no existing entry is recorded outright
  /// if the board has room (`entries.size() < keep`), or if `score` beats
  /// the current worst kept entry (`entries` is always sorted, so that's
  /// just the last one) — otherwise it's not yet good enough to bump
  /// anyone off the buffer.
  public func recordIfBetter(b : Board, player : Text, score : Int, now : Int) : Bool {
    switch (indexOf(b, player)) {
      case (?i) {
        if (score <= b.entries[i].score) return false;
      };
      case null {
        if (b.entries.size() >= b.keep) {
          let worst = b.entries[b.entries.size() - 1].score;
          if (score <= worst) return false;
        };
      };
    };
    upsert(b, { player; score; updatedAt = now });
    true;
  };

  /// The top `n` entries, highest score first — a host's `get_leaderboard`
  /// query is a one-line wrapper over this (typically `top(board, 25)`
  /// against a board kept at `new(50)`; see this module's own doc header
  /// for why the two numbers needn't match). `n` beyond `entries.size()`
  /// just returns everything there is, no error.
  public func top(b : Board, n : Nat) : [Entry] {
    if (n >= b.entries.size()) b.entries else b.entries.sliceToArray(0, n);
  };

  /// One player's current entry, if they have one — for a host that needs
  /// a single score back rather than a ranked slice (e.g. looking up a
  /// player's existing ELO rating, or lack of one, right before computing
  /// their next one). `null` covers both "never recorded" and "recorded
  /// once, then bumped off the buffer by better players since" — the two
  /// are indistinguishable here by design, same as a real leaderboard.
  public func get(b : Board, player : Text) : ?Entry {
    switch (indexOf(b, player)) {
      case (?i) ?b.entries[i];
      case null null;
    };
  };

  /// `get(b, player)`'s own score, or `b.defaultScore` if they have none
  /// yet — the common case for a rating that has to look up "what am I
  /// updating FROM" before computing a new value (e.g. `Elo.update`'s own
  /// two input ratings), sparing every such caller its own `switch` over
  /// `get`.
  public func scoreOf(b : Board, player : Text) : Int {
    switch (get(b, player)) {
      case (?e) e.score;
      case null b.defaultScore;
    };
  };
};
