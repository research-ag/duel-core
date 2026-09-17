// TypeScript mirror of ../../src/Types.mo's Candid shapes (see idl.ts).
// `[] | [T]` is `@icp-sdk/core`'s wire representation of Candid's
// `opt T` — `optToMaybe`/`maybeToOpt` below convert to/from a plain
// `T | undefined` at the edges so components never juggle that shape.

import type { Principal } from "@icp-sdk/core/principal";

export interface Profile {
  displayName: string;
}

export type GameId = Principal;

export interface GameView {
  developer: Principal;
  developerDisplayName: [] | [string];
  title: string;
  description: string;
  backendCanisterId: Principal;
  frontendCanisterId: Principal;
  customDomain: [] | [string];
  createdAt: bigint;
  updatedAt: bigint;
}

export interface GameInput {
  title: string;
  description: string;
  backendCanisterId: Principal;
  frontendCanisterId: Principal;
  customDomain: [] | [string];
  banner: Uint8Array;
}

export interface GameEdit {
  title: string;
  description: string;
  frontendCanisterId: Principal;
  customDomain: [] | [string];
  banner: [] | [Uint8Array];
}

export type Err =
  | { anonymousCaller: null }
  | { emptyDisplayName: null }
  | { displayNameTooLong: null }
  | { emptyTitle: null }
  | { titleTooLong: null }
  | { descriptionTooLong: null }
  | { invalidCustomDomain: null }
  | { invalidBanner: string }
  | { gameAlreadyRegistered: null }
  | { noSuchGame: null }
  | { notOwner: null };

export type UnitResult = { ok: null } | { err: Err };
export type GameIdResult = { ok: GameId } | { err: Err };

export interface BannerRequirements {
  width: bigint;
  height: bigint;
  maxBytes: bigint;
}

export interface AggregatorActor {
  setDisplayName(name: string): Promise<UnitResult>;
  getProfile(who: Principal): Promise<[] | [Profile]>;
  getBannerRequirements(): Promise<BannerRequirements>;
  registerGame(input: GameInput): Promise<GameIdResult>;
  updateGame(id: GameId, edit: GameEdit): Promise<UnitResult>;
  deregisterGame(id: GameId): Promise<UnitResult>;
  listGames(): Promise<GameView[]>;
  listGamesByDeveloper(developer: Principal): Promise<GameView[]>;
  getGame(id: GameId): Promise<[] | [GameView]>;
  getBanner(id: GameId): Promise<[] | [Uint8Array]>;
}

export function optToMaybe<T>(opt: [] | [T]): T | undefined {
  return opt.length > 0 ? opt[0] : undefined;
}

export function maybeToOpt<T>(v: T | undefined | null): [] | [T] {
  return v == null ? [] : [v];
}

/// The game's own live URL: its `customDomain` if the developer set one,
/// otherwise the default `https://<frontend-canister-id>.icp.net`.
export function gameUrl(game: GameView): string {
  const custom = optToMaybe(game.customDomain);
  return custom ?? `https://${game.frontendCanisterId.toText()}.icp.net`;
}

/// A human-readable message for every `Err` arm — shown directly in a
/// form's own error banner.
export function errMessage(err: Err): string {
  if ("anonymousCaller" in err) return "You must be logged in with Internet Identity.";
  if ("emptyDisplayName" in err) return "Display name cannot be empty.";
  if ("displayNameTooLong" in err) return "Display name is too long.";
  if ("emptyTitle" in err) return "Title cannot be empty.";
  if ("titleTooLong" in err) return "Title is too long.";
  if ("descriptionTooLong" in err) return "Description is too long.";
  if ("invalidCustomDomain" in err) {
    return "Custom domain must start with https:// or http://.";
  }
  if ("invalidBanner" in err) return err.invalidBanner;
  if ("gameAlreadyRegistered" in err) {
    return "A game with this backend canister id is already registered.";
  }
  if ("noSuchGame" in err) return "That game no longer exists.";
  if ("notOwner" in err) return "You are not the developer of this game.";
  return "Something went wrong.";
}
