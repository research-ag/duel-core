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

  /// A uniform number in `0..n-1`; traps on `n == 0` or `n >= 2^64`.
  ///
  /// A plain `next() % n` favours the residues below `2^64 mod n` by one
  /// preimage each. Instead, keep only the bits of `next()` that `n - 1`
  /// spans and draw again on a value of `n` or more: every survivor is
  /// equally likely, and fewer than half the draws are rejected.
  public func below(self : Rng, n : Nat) : Nat {
    assert n > 0;
    if (n == 1) return 0;
    let n64 = n.toNat64(); // traps beyond 2^64 - 1
    let mask = Nat64.maxValue >> Nat64.bitcountLeadingZero(n64 - 1);
    loop {
      let x = Prng.SFC64.next(self.sfc) & mask;
      if (x < n64) return x.toNat();
    };
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
