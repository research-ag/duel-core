import Iter "mo:core/Iter";
import Nat8 "mo:core/Nat8";

/// Minimal PNG header inspection — just enough to reject a banner upload
/// that isn't a PNG or isn't the exact pixel size the aggregator
/// requires, without pulling in a full image-decoding library. Reads the
/// fixed 8-byte PNG signature and the width/height fields of the first
/// chunk, which the PNG spec guarantees is `IHDR` — everything after
/// byte 24 (pixel data, palette, other chunks) is irrelevant here and
/// left unparsed.
module {

  let SIGNATURE : [Nat8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  let IHDR : [Nat8] = [0x49, 0x48, 0x44, 0x52]; // ascii "IHDR"

  func hasBytesAt(bytes : [Nat8], offset : Nat, expected : [Nat8]) : Bool {
    var i = 0;
    var ok = true;
    for (b in expected.values()) {
      if (bytes[offset + i] != b) { ok := false };
      i += 1;
    };
    ok;
  };

  func u32be(bytes : [Nat8], offset : Nat) : Nat {
    Nat8.toNat(bytes[offset]) * 16_777_216 +
    Nat8.toNat(bytes[offset + 1]) * 65_536 +
    Nat8.toNat(bytes[offset + 2]) * 256 +
    Nat8.toNat(bytes[offset + 3]);
  };

  /// `?(width, height)` in pixels, read from the PNG signature + `IHDR`
  /// chunk; `null` if `png` is too short or doesn't start with a valid
  /// PNG signature followed by an `IHDR` chunk.
  public func dimensions(png : Blob) : ?(Nat, Nat) {
    let bytes : [Nat8] = Iter.toArray<Nat8>(png.values());
    if (bytes.size() < 24) {
      null;
    } else if (not hasBytesAt(bytes, 0, SIGNATURE)) {
      null;
    } else if (not hasBytesAt(bytes, 12, IHDR)) {
      null;
    } else {
      ?(u32be(bytes, 16), u32be(bytes, 20));
    };
  };
};
