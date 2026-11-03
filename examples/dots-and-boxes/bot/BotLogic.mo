/// BotLogic — how the Dots & Boxes bot picks a line, as a pure module
/// (no actor, no Time, no storage) so `test/Bot.test.mo` can call it.
///
/// Two ways to play, declared in `COMPLEXITIES` and chosen per game:
///   Easy  takes a box when one is offered (any line that closes a box),
///         otherwise draws any undrawn line at random, happily handing
///         boxes to the opponent.
///   Hard  takes every box it can; otherwise draws a SAFE line (one that
///         does not give a box a third side); when every line is unsafe
///         it sacrifices the cheapest one: the line whose chain hands the
///         opponent the fewest boxes.
/// Unknown complexities play Easy. Randomness comes from the `seed` the
/// actor passes in (`Time.now()`), mixed with the seat and step so two
/// copies of the bot asked in the same round do not mirror each other.

import Array "mo:core/Array";
import Int "mo:core/Int";
import List "mo:core/List";
import Nat "mo:core/Nat";

import TP "mo:duel-game-core";

import Rules "../src/DotsAndBoxesRules";

module {

  /// Sent by `Bot.mo`'s `register`; the first is what a UI lists first.
  public let COMPLEXITIES : [Text] = ["Easy", "Hard"];

  public func chooseMove(req : TP.MoveRequest<Rules.View, Rules.Action>, seed : Int) : Rules.Action {
    let salt = Int.abs(seed) + req.step * 7919 + (switch (req.seat) { case (#p1) 0; case (#p2) 104_729 });
    let line = if (req.complexity == "Hard") hardLine(req.game, req.seat, salt) else easyLine(req.game, req.seat, salt);
    #draw { line };
  };

  // ── board reading ──────────────────────────────────────────────────────

  func drawnSides(s : Rules.State, b : Nat) : Nat = Rules.boxSides(s.size, b).foldLeft<Nat, Nat>(0, func(acc, l) = if (s.lines[l] != null) acc + 1 else acc);

  /// Every undrawn line.
  public func undrawn(s : Rules.State) : [Nat] {
    let out = List.empty<Nat>();
    for (i in Nat.range(0, s.lines.size())) {
      if (s.lines[i] == null) out.add(i);
    };
    out.toArray();
  };

  /// Boxes `line` would close (unclaimed, three sides drawn).
  public func closes(s : Rules.State, line : Nat) : Nat = Rules.boxesOfLine(s.size, line).foldLeft<Nat, Nat>(
    0,
    func(acc, b) = if (s.boxes[b] == null and drawnSides(s, b) == 3) acc + 1 else acc,
  );

  /// Whether `line` gives some box its third side (an offer to the opponent).
  public func givesThirdSide(s : Rules.State, line : Nat) : Bool = Rules.boxesOfLine(s.size, line).any(func(b) = s.boxes[b] == null and drawnSides(s, b) == 2);

  func after(s : Rules.State, seat : TP.Seat, line : Nat) : Rules.State = Rules.resolve(s, seat, #draw { line }).state;

  /// How many boxes a greedy opponent collects after `seat` draws `line`:
  /// the opponent keeps closing three-sided boxes until none is left.
  public func giveaway(s : Rules.State, seat : TP.Seat, line : Nat) : Nat {
    var cur = after(s, seat, line);
    let opp = Rules.otherSeat(seat);
    var taken = 0;
    label chain loop {
      var found : ?Nat = null;
      label scan for (l in undrawn(cur).values()) {
        if (closes(cur, l) > 0) { found := ?l; break scan };
      };
      switch (found) {
        case null break chain;
        case (?l) {
          taken += closes(cur, l);
          cur := after(cur, opp, l);
        };
      };
    };
    taken;
  };

  func pick(xs : [Nat], salt : Nat) : Nat = xs[salt % xs.size()];

  // ── the two players ────────────────────────────────────────────────────

  func capturing(s : Rules.State, lines : [Nat]) : [Nat] = lines.filter(func(l) = closes(s, l) > 0);

  func easyLine(s : Rules.State, _seat : TP.Seat, salt : Nat) : Nat {
    let lines = undrawn(s);
    let caps = capturing(s, lines);
    if (caps.size() > 0) pick(caps, salt) else pick(lines, salt);
  };

  func hardLine(s : Rules.State, seat : TP.Seat, salt : Nat) : Nat {
    let lines = undrawn(s);
    let caps = capturing(s, lines);
    if (caps.size() > 0) return pick(caps, salt);
    let safe = lines.filter(func(l) = not givesThirdSide(s, l));
    if (safe.size() > 0) return pick(safe, salt);
    // Every line opens something: give away as little as possible.
    var best : Nat = s.boxes.size() + 1;
    let cheapest = List.empty<Nat>();
    for (l in lines.values()) {
      let cost = giveaway(s, seat, l);
      if (cost < best) {
        best := cost;
        cheapest.clear();
        cheapest.add(l);
      } else if (cost == best) cheapest.add(l);
    };
    pick(cheapest.toArray(), salt);
  };
};
