/// The racing bot's move-selection logic, factored out of `Bot.mo` as a
/// plain, pure module — so it can be exercised directly in
/// `test/Bot.test.mo` (constructing a synthetic `TP.MoveRequest` by hand
/// and calling `chooseMove`, no actor/Candid round-trip at all — the same
/// "testing offline" pattern `../../../CLAUDE.md`'s "Canister players"
/// note describes) as well as wired live from `Bot.mo`'s own `make_move`.
import Nat "mo:core/Nat";

import TP "mo:duel-game-core";
import Rules "RacingRules";

module {

  /// One entry per round, straight ahead (`c = 0.0`), at a gentle ~25%
  /// throttle. Generated once, offline, by simulating
  /// `RacingRules.nextStepArea` forward from a standing start (`speed =
  /// 0.0`, `l := 0.25 * area.maxDistance`, then advancing speed by
  /// `RacingRules`' own straight-driving formula, `newSpeed = 2*l -
  /// speed`) — so every entry is guaranteed legal
  /// (`RacingRules.validate`-passing) at exactly the speed the car has
  /// after the entries before it; `test/Bot.test.mo` replays this exact
  /// trajectory through the real `RacingRules.validate`/`resolve` as a
  /// permanent regression guard. The speed this produces converges to a
  /// steady ~2.77 units/step by the last few entries, so repeating the
  /// FINAL entry forever (see `chooseMove` below) stays legal indefinitely
  /// too, right up until the car actually reaches a bend and leaves the
  /// track — this bot never steers, so it has no way to recover from that,
  /// and simply stops submitting from then on. That silence is
  /// intentional, not a bug: it's the same "no reply" case
  /// `canister_players.mo` already treats identically to an unresponsive
  /// human, and the match ends the same way theirs would, via `claimWin`
  /// or idle takeover.
  public let SCRIPT : [Rules.Action] = [
    { l = 2.083_333_333_333_333_5; c = 0.0 },
    { l = 3.119_377_411_265_432_4; c = 0.0 },
    { l = 2.598_730_326_712_068; c = 0.0 },
    { l = 2.860_587_292_383_813; c = 0.0 },
    { l = 2.728_941_752_028_73; c = 0.0 },
    { l = 2.795_138_709_031_119_7; c = 0.0 },
    { l = 2.761_855_535_797_853; c = 0.0 },
    { l = 2.778_590_860_396_709_8; c = 0.0 },
    { l = 2.770_176_286_396_108; c = 0.0 },
    { l = 2.774_407_216_693_490_8; c = 0.0 },
  ];

  /// Ignores everything about `req` except `turn` — see `SCRIPT`'s own doc
  /// comment for why that's enough. Clamps to the script's last entry once
  /// `turn` runs past it, rather than reaching for `req.game`/physics at
  /// all: this bot is deliberately as simple as `canister_players.mo`'s
  /// own protocol allows.
  public func chooseMove(req : TP.MoveRequest<Rules.State>) : Rules.Action {
    SCRIPT[Nat.min(req.turn, SCRIPT.size() - 1 : Nat)];
  };

};
