// A tiny in-memory stand-in for a canister wired with
// `mo:duel-game-core/transport`: answers each `duel_request` with a view
// or an error, and `duel_poll` from the session's current revision.

import { IDL } from "@icp-sdk/core/candid";
import { buildEngineTypes, type EngineTypes } from "../../src/idl.js";
import type { PollResult, TransportActor } from "../../src/transport.js";
import type { EngineErr, Status, WsRequest } from "../../src/types.js";

export function sampleGameTypes({ IDL: I }: { IDL: typeof IDL }) {
  return { Action: I.Variant({ pass: I.Null }), State: I.Record({ hp: I.Nat }) };
}

export const ENDED: Status = { atTable: { id: 1n, view: { endedByOther: null } } };
export const BROWSING: Status = { browsing: { tables: [] } };

export class FakeCanister implements TransportActor {
  private types: EngineTypes;
  /// The session's current revision and status; `null` = no link.
  rev: bigint | null = null;
  current: Status = ENDED;
  private nextRev = 100n;

  /// What to reply with for the next decoded request. Override per test.
  respond: (req: WsRequest) => { view: Status } | { err: EngineErr } = () => ({ view: this.current });
  /// How many upcoming `duel_request` calls throw before one lands.
  failRequests = 0;
  /// Whether a throwing `duel_request` still applies the request.
  landsBeforeFailing = false;
  pollBehavior: "ok" | "err" = "ok";
  /// Every decoded request, in arrival order, with the epoch it carried.
  requests: Array<{ sid: string; epoch: bigint; req: WsRequest }> = [];
  polls = 0;
  /// Every `duel_request` call, thrown ones included.
  attempts = 0;

  constructor() {
    const { Action, State } = sampleGameTypes({ IDL });
    this.types = buildEngineTypes({ IDL, Action, State });
  }

  private _encode(value: unknown): Uint8Array {
    const buf = IDL.encode([this.types.WsMsg], [value]);
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  }

  get sent(): WsRequest[] {
    return this.requests.map((r) => r.req);
  }

  /// Test-only: the other seat acted — a new revision for the next poll.
  push(view: Status): void {
    this.current = view;
    this.rev = this.nextRev++;
  }

  /// Test-only: an upgrade or a prune.
  forget(): void {
    this.rev = null;
  }

  private _handle(msg: Uint8Array): Uint8Array {
    const decoded = IDL.decode([this.types.WsMsg], msg)[0] as unknown as {
      req: { sid: string; epoch: bigint; req: WsRequest };
    };
    this.requests.push(decoded.req);
    if ("bye" in decoded.req.req) return this._encode({ view: { rev: this.rev ?? 0n, view: this.current } });
    if (this.rev === null) this.rev = this.nextRev++;
    const reply = this.respond(decoded.req.req);
    if ("err" in reply) return this._encode({ err: { err: reply.err } });
    if (!("status" in decoded.req.req)) this.rev = this.nextRev++;
    this.current = reply.view;
    return this._encode({ view: { rev: this.rev, view: reply.view } });
  }

  async duel_request(msg: Uint8Array): Promise<Uint8Array> {
    this.attempts++;
    if (this.failRequests > 0) {
      this.failRequests--;
      if (this.landsBeforeFailing) this._handle(msg);
      throw new Error("network down");
    }
    return this._handle(msg);
  }

  async duel_poll(_sid: string, rev: bigint): Promise<PollResult> {
    this.polls++;
    if (this.pollBehavior === "err") throw new Error("unavailable");
    if (this.rev === null) return { unknown: null };
    if (this.rev === rev) return { unchanged: null };
    return { changed: this._encode({ view: { rev: this.rev, view: this.current } }) };
  }

  async status(_sid: string): Promise<Status> {
    return this.current;
  }
}
