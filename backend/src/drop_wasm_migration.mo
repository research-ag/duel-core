/// One-off upgrade migration for a host whose live build still keeps the
/// HTTP mixin's copy of its own module (the stable `wasm` field): drops
/// it. Put `(with migration = DropWasmMigration.run)` before the host's
/// `actor` for that one upgrade, then remove the clause and the import.
/// See README, "Downloadable wasm".
import List "mo:core/List";

module {

  public func run(_ : { wasm : { var live : [Blob]; staged : List.List<Blob> } }) : {} = {};

};
