// A tiny in-memory stand-in for a canister wired with
// `mo:duel-game-core/transport`: answers `duel_submit` with a view or an
// error, every other request with an `Ack` or an error, and `duel_poll`
// from the session's current revision.

import { IDL } from "@icp-sdk/core/candid";
import { buildEngineTypes, type EngineTypes } from "../../src/idl.js";
import type { Ack, PollResult, TransportActor } from "../../src/transport.js";

type Reply = { view: { rev: bigint; view: Status } } | { err: EngineErr };
import type { EngineErr, Seat, Status, TransportRequest, Visibility } from "../../src/types.js";

export function sampleGameTypes({ IDL: I }: { IDL: typeof IDL }) {
  return {
    Action: I.Variant({ pass: I.Null }),
    State: I.Record({ hp: I.Nat }),
  };
}

export const ENDED: Status = {
  atTable: { id: 1n, view: { endedByOther: null } },
};
export const BROWSING: Status = { browsing: { tables: [] } };

export class FakeCanister implements TransportActor {
  private types: EngineTypes;
  /// The session's current revision and status; `null` = no link.
  rev: bigint | null = null;
  current: Status = ENDED;
  private nextRev = 100n;

  /// What to reply with for the next decoded request. Override per test.
  respond: (req: TransportRequest) => { view: Status } | { err: EngineErr } = () => ({
    view: this.current,
  });
  /// How many upcoming update calls throw before one lands.
  failRequests = 0;
  /// Whether a throwing update call still applies the request.
  landsBeforeFailing = false;
  pollBehavior: "ok" | "err" | "hang" | "throw" = "ok";
  /// How long each `duel_poll` takes to answer.
  pollDelayMs = 0;
  /// Every decoded request, in arrival order.
  requests: Array<{ sid: string; req: TransportRequest }> = [];
  polls = 0;
  /// Every update call, thrown ones included.
  attempts = 0;

  constructor() {
    const { Action, State } = sampleGameTypes({ IDL });
    this.types = buildEngineTypes({ IDL, Action, State });
  }

  /// Round-trips `value` through Candid as the agent would, so a shape
  /// that does not match the IDL fails here too.
  private _wire<T>(types: IDL.Type[], values: unknown[]): T {
    const buf = IDL.encode(types, values);
    return IDL.decode(types, buf instanceof Uint8Array ? buf : new Uint8Array(buf)) as unknown as T;
  }

  get sent(): TransportRequest[] {
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

  private _handle(sid: string, req: TransportRequest): Reply {
    this.requests.push({ sid, req });
    if (this.rev === null) this.rev = this.nextRev++;
    const reply = this.respond(req);
    let out: Reply;
    if ("err" in reply) {
      out = { err: reply.err };
    } else {
      if (!("status" in req)) this.rev = this.nextRev++;
      this.current = reply.view;
      out = { view: { rev: this.rev, view: reply.view } };
    }
    return this._wire<[Reply]>([this.types.TransportReply], [out])[0];
  }

  private _update(sid: string, req: TransportRequest): Reply {
    this.attempts++;
    if (this.failRequests > 0) {
      this.failRequests--;
      if (this.landsBeforeFailing) this._handle(sid, req);
      throw new Error("network down");
    }
    return this._handle(sid, req);
  }

  private async _acked(sid: string, req: TransportRequest): Promise<Ack> {
    const reply = this._update(sid, req);
    const ack: Ack = "err" in reply ? { err: reply.err } : { ok: { rev: reply.view.rev } };
    return this._wire<[Ack]>([this.types.Ack], [ack])[0];
  }

  async duel_submit(sid: string, gen: bigint, turn: bigint, move: unknown): Promise<Reply> {
    const [s, g, t, m] = this._wire<[string, bigint, bigint, unknown]>(
      [IDL.Text, IDL.Nat, IDL.Nat, sampleGameTypes({ IDL }).Action],
      [sid, gen, turn, move]
    );
    return this._update(s, { submit: { gen: g, turn: t, move: m } });
  }
  duel_create_table(sid: string, seat: Seat, visibility: Visibility, variant: string): Promise<Ack> {
    return this._acked(sid, { createTable: { seat, visibility, variant } });
  }
  duel_join_table(sid: string, id: bigint, seat: Seat, code: [] | [string]): Promise<Ack> {
    return this._acked(sid, { joinTable: { id, seat, code } });
  }
  duel_rematch(sid: string): Promise<Ack> {
    return this._acked(sid, { rematch: null });
  }
  duel_leave(sid: string, gen: bigint): Promise<Ack> {
    return this._acked(sid, { leave: { gen } });
  }
  duel_reset(sid: string, gen: bigint): Promise<Ack> {
    return this._acked(sid, { reset: { gen } });
  }
  duel_claim_win(sid: string, gen: bigint): Promise<Ack> {
    return this._acked(sid, { claimWin: { gen } });
  }
  duel_ack_ended(sid: string): Promise<Ack> {
    return this._acked(sid, { ackEnded: null });
  }
  duel_ping(sid: string): Promise<Ack> {
    return this._acked(sid, { status: null });
  }

  duel_poll(sid: string, rev: bigint): Promise<PollResult> {
    this.polls++;
    if (this.pollBehavior === "throw") throw new Error("not async");
    return this._poll(sid, rev);
  }

  private async _poll(_sid: string, rev: bigint): Promise<PollResult> {
    if (this.pollBehavior === "err") throw new Error("unavailable");
    if (this.pollBehavior === "hang") return new Promise(() => {});
    if (this.pollDelayMs > 0)
      await new Promise((r) => setTimeout(r, this.pollDelayMs));
    if (this.rev === null) return { unknown: null };
    if (this.rev === rev) return { unchanged: null };
    const res = { changed: { rev: this.rev, view: this.current } };
    return this._wire<[PollResult]>([this.types.PollResult], [res])[0];
  }

  async status(_sid: string): Promise<Status> {
    return this.current;
  }
}
