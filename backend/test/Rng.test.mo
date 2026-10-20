// rng.mo: `below` stays in range, is exactly uniform over 2^64 (every
// residue has the same number of preimages), and `shuffle` is a uniform
// permutation.
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";
import Array "mo:core/Array";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import VarArray "mo:core/VarArray";
import Rng "../src/rng";

let rng = Rng.new(7);

// 1. Range and determinism from a seed.
var i = 0;
while (i < 1000) {
  let x = rng.below(40);
  if (x >= 40) Runtime.trap("below(40) out of range");
  i += 1;
};
let a = Rng.new(1);
let b = Rng.new(1);
i := 0;
while (i < 20) {
  assert a.next() == b.next();
  assert a.below(1000) == b.below(1000);
  i += 1;
};
let deck = Array.tabulate<Nat>(20, func(k) = k);
assert a.shuffle(deck) == b.shuffle(deck);
assert a.next() == b.next();
assert Rng.new(1).below(1) == 0;
Debug.print("1. range OK");

// 2. No modulo bias: the mask keeps exactly the bits `n - 1` spans, so
// every survivor is one of `mask + 1` equally likely values and the ones
// kept (`< n`) are at least half of them. Check that arithmetic for a few
// n, including ones that are not powers of two, and the edges.
for (n in [2, 3, 7, 40, 49, 1000, 4_294_967_296, 18_446_744_073_709_551_615].values()) {
  let n64 = n.toNat64();
  let mask = Nat64.maxValue >> Nat64.bitcountLeadingZero(n64 - 1);
  assert mask >= n64 - 1; // every value below n survives the mask
  assert n64 > mask / 2; // at most half of the `mask + 1` survivors are rejected
  assert rng.below(n) < n;
};
Debug.print("2. uniformity arithmetic OK");

// 3. shuffle is a permutation.
let xs = Array.tabulate<Nat>(40, func(k) = k);
let ys = rng.shuffle(xs);
assert ys.size() == 40;
let sorted = ys.sort<Nat>(func(a, b) = if (a < b) #less else if (a > b) #greater else #equal);
assert sorted == xs;
Debug.print("3. shuffle OK");

// 4. shuffle is uniform: 6000 shuffles of [0, 1, 2] hit each of the six
// permutations about 1000 times (one standard deviation is ~29; the seed
// is fixed, so this is deterministic, and +-150 is over 5 of them).
do {
  let counts = [var 0, 0, 0, 0, 0, 0];
  var k = 0;
  while (k < 6000) {
    let p = rng.shuffle([0, 1, 2]);
    let code = p[0] * 2 + (if (p[1] < p[2]) 0 else 1); // first element, then the order of the rest
    counts[code] += 1;
    k += 1;
  };
  for (c in counts.vals()) {
    if (c < 850 or c > 1150) Runtime.trap("4: a permutation was hit " # debug_show c # " times in 6000");
  };
  Debug.print("4. shuffle uniform: " # debug_show counts.toArray());
};

Debug.print("ALL RNG CHECKS PASSED");
