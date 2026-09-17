// Hand-written Candid interface for the aggregator backend
// (../../src/Main.mo). Verified against `moc --idl`'s own generated .did
// for that actor — keep this in sync if Main.mo's service surface ever
// changes.
//
// Unlike duel-game-core/idl.ts (a factory parameterized over a game's own
// Action/State), this canister's interface is fixed — there is nothing
// game-specific about the aggregator itself — so this is a plain
// `idlFactory`, not a factory-of-factories.

import type { IDL } from "@icp-sdk/core/candid";

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Profile = IDL.Record({ displayName: IDL.Text });

  const GameId = IDL.Principal;

  const GameView = IDL.Record({
    developer: IDL.Principal,
    developerDisplayName: IDL.Opt(IDL.Text),
    title: IDL.Text,
    description: IDL.Text,
    backendCanisterId: IDL.Principal,
    frontendCanisterId: IDL.Principal,
    customDomain: IDL.Opt(IDL.Text),
    createdAt: IDL.Int,
    updatedAt: IDL.Int,
  });

  const GameInput = IDL.Record({
    title: IDL.Text,
    description: IDL.Text,
    backendCanisterId: IDL.Principal,
    frontendCanisterId: IDL.Principal,
    customDomain: IDL.Opt(IDL.Text),
    banner: IDL.Vec(IDL.Nat8),
  });

  const GameEdit = IDL.Record({
    title: IDL.Text,
    description: IDL.Text,
    frontendCanisterId: IDL.Principal,
    customDomain: IDL.Opt(IDL.Text),
    banner: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });

  // Every arm here is a bare tag except `invalidBanner`, matching
  // Main.mo's Types.mo `Err` variant exactly (a bare candid variant tag
  // ~ a `null`-typed field).
  const Err = IDL.Variant({
    anonymousCaller: IDL.Null,
    emptyDisplayName: IDL.Null,
    displayNameTooLong: IDL.Null,
    emptyTitle: IDL.Null,
    titleTooLong: IDL.Null,
    descriptionTooLong: IDL.Null,
    invalidCustomDomain: IDL.Null,
    invalidBanner: IDL.Text,
    gameAlreadyRegistered: IDL.Null,
    noSuchGame: IDL.Null,
    notOwner: IDL.Null,
  });

  const UnitResult = IDL.Variant({ ok: IDL.Null, err: Err });
  const GameIdResult = IDL.Variant({ ok: GameId, err: Err });

  const BannerRequirements = IDL.Record({
    width: IDL.Nat,
    height: IDL.Nat,
    maxBytes: IDL.Nat,
  });

  return IDL.Service({
    setDisplayName: IDL.Func([IDL.Text], [UnitResult], []),
    getProfile: IDL.Func([IDL.Principal], [IDL.Opt(Profile)], ["query"]),
    getBannerRequirements: IDL.Func([], [BannerRequirements], ["query"]),
    registerGame: IDL.Func([GameInput], [GameIdResult], []),
    updateGame: IDL.Func([GameId, GameEdit], [UnitResult], []),
    deregisterGame: IDL.Func([GameId], [UnitResult], []),
    listGames: IDL.Func([], [IDL.Vec(GameView)], ["query"]),
    listGamesByDeveloper: IDL.Func([IDL.Principal], [IDL.Vec(GameView)], ["query"]),
    getGame: IDL.Func([GameId], [IDL.Opt(GameView)], ["query"]),
    getBanner: IDL.Func([GameId], [IDL.Opt(IDL.Vec(IDL.Nat8))], ["query"]),
  });
};
