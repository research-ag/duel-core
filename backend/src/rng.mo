/// duel-game-core/rng — the random-number generator a game's rules draw
/// from. One per `Duel`, kept in its stable data, seeded from the clock at
/// install, and handed to `init`/`move`/`resolve`. Statistical, not
/// cryptographic.
///
///   let card = rng.below(40) + 1;     // 1..40
///   let deck = rng.shuffle(cards);

import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import VarArray "mo:core/VarArray";
import Array "mo:core/Array";
import Prng "mo:prng";

module {

  public type Rng = { sfc : Prng.SFC64.SFC64 };

  public func new(seed : Nat64) : Rng = { sfc = Prng.SFC64.SFC64a(seed) };

  /// A uniform `Nat64`.
  public func next(self : Rng) : Nat64 = Prng.SFC64.next(self.sfc);

  /// A uniform number in `0..n-1`; traps on `n == 0`.
  public func below(self : Rng, n : Nat) : Nat {
    assert n > 0;
    (Prng.SFC64.next(self.sfc)).toNat() % n;
  };

  /// `xs` in a uniformly random order (Fisher–Yates).
  public func shuffle<T>(self : Rng, xs : [T]) : [T] {
    let a = xs.toVarArray<T>();
    var i = a.size();
    while (i > 1) {
      let j = below(self, i);
      i -= 1;
      let t = a[i];
      a[i] := a[j];
      a[j] := t;
    };
    a.toArray();
  };
};
