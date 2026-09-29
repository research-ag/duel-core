/// A generic top-N score board: `Text` player key, `Int` score, always
/// sorted highest-first and trimmed to `keep`. A lower-is-better metric
/// is converted by the game before storing. `Board` is a plain mutable
/// record, so a host's field is stable. See `../README.md`, "Leaderboard".

import Array "mo:core/Array";
import Int "mo:core/Int";
import Order "mo:core/Order";

module {

  public type Entry = { player : Text; score : Int; updatedAt : Int };

  /// `defaultScore` is what `scoreOf` returns for an unknown player.
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

  // `keep` is small, so a full re-sort per write is fine.
  func upsert(b : Board, e : Entry) {
    let withoutOld = b.entries.filter(func(x : Entry) : Bool = x.player != e.player);
    let merged = Array.concat(withoutOld, [e]);
    let sorted = merged.sort(func(a : Entry, b : Entry) : Order.Order = Int.compare(b.score, a.score));
    b.entries := if (sorted.size() > b.keep) sorted.sliceToArray(0, b.keep) else sorted;
  };

  /// Unconditional overwrite — for a rating that moves either way.
  public func setScore(b : Board, player : Text, score : Int, now : Int) {
    upsert(b, { player; score; updatedAt = now });
  };

  /// Overwrites only on a strict improvement (or a first entry that makes
  /// the cut) — for a personal best. Returns whether anything changed.
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

  public func top(b : Board, n : Nat) : [Entry] {
    if (n >= b.entries.size()) b.entries else b.entries.sliceToArray(0, n);
  };

  /// `null` for "never recorded" and "bumped off the buffer" alike.
  public func get(b : Board, player : Text) : ?Entry {
    switch (indexOf(b, player)) {
      case (?i) ?b.entries[i];
      case null null;
    };
  };

  public func scoreOf(b : Board, player : Text) : Int {
    switch (get(b, player)) {
      case (?e) e.score;
      case null b.defaultScore;
    };
  };
};
