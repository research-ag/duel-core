/// One-off: upgrades the live canister from the session layout. Delete
/// this file, its import and the `with migration` clause in `Host.mo`
/// once that upgrade is live. See the backend README, "Upgrading from the
/// session layout".
import LegacyLayoutMigration "mo:duel-game-core/legacy_layout_migration";

import Rules "ChopsticksRules";

module {

  type OldState = {
    variant : Rules.Variant;
    p1 : Rules.Hands;
    p2 : Rules.Hands;
  };

  func variantOf(raw : Text) : Rules.Variant = if (raw == "instructables") #instructables else #classic;

  public func run(old : LegacyLayoutMigration.OldWithElo<OldState, Rules.Action>) : LegacyLayoutMigration.New<Rules.State, Rules.Action, Rules.Options> = LegacyLayoutMigration.run(
    old,
    {
      options = variantOf;
      state = func(s : OldState, turn : Nat) : Rules.State = {
        variant = s.variant;
        p1 = s.p1;
        p2 = s.p2;
        toMove = LegacyLayoutMigration.seatOnTurn(turn);
      };
    },
  );

};
