/// One-off: upgrades the live canister from the session layout. Delete
/// this file, its import and the `with migration` clause in `Host.mo`
/// once that upgrade is live. See the backend README, "Upgrading from the
/// session layout".
import LegacyLayoutMigration "mo:duel-game-core/legacy_layout_migration";

import Rules "CheckersRules";

module {

  type OldState = { board : Rules.Board };

  public func run(old : LegacyLayoutMigration.OldWithElo<OldState, Rules.Action>) : LegacyLayoutMigration.New<Rules.State, Rules.Action, Rules.Options> = LegacyLayoutMigration.run(
    old,
    {
      options = func(_ : Text) : Rules.Options = {};
      state = func(s : OldState, turn : Nat) : Rules.State = {
        board = s.board;
        toMove = LegacyLayoutMigration.seatOnTurn(turn);
      };
    },
  );

};
