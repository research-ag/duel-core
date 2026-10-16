/// One-off: upgrades the live canister from the session layout. Delete
/// this file, its import and the `with migration` clause in `Host.mo`
/// once that upgrade is live. See the backend README, "Upgrading from the
/// session layout".
import LegacyLayoutMigration "mo:duel-game-core/legacy_layout_migration";

import Rules "RockPaperScissorsRules";

module {

  type OldState = {
    p1Score : Nat;
    p2Score : Nat;
    lastRound : ?Rules.Round;
    variant : Rules.Variant;
  };

  let OLD_WINS_NEEDED = 3;

  public func run(old : LegacyLayoutMigration.OldWithElo<OldState, Rules.Action>) : LegacyLayoutMigration.New<Rules.State, Rules.Action, Rules.Options> = LegacyLayoutMigration.run(
    old,
    {
      options = func(raw : Text) : Rules.Options = {
        variant = if (raw == "well") #well else #classic;
        winsNeeded = OLD_WINS_NEEDED;
      };
      state = func(s : OldState, _ : Nat) : Rules.State = {
        s with winsNeeded = OLD_WINS_NEEDED
      };
    },
  );

};
