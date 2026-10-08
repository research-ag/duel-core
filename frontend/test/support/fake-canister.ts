// A tiny in-memory stand-in for a canister wired with
// `mo:duel-game-core/transport`: answers each `duel_request` with a view
// or an error, and `duel_poll` from the session's current revision.

import { IDL } from "@icp-sdk/core/candid";
import { buildEngineTypes, type EngineTypes } from "../../src/idl.js";
import type { PollResult, TransportActor } from "../../src/transport.js";

type Reply = { view: { rev: bigint; view: Status } } | { err: EngineErr };
import type { EngineErr, Status, TransportRequest } from "../../src/types.js";

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
  /// How many upcoming `duel_request` calls throw before one lands.
  failRequests = 0;
  /// Whether a throwing `duel_request` still applies the request.
  landsBeforeFailing = false;
  pollBehavior: "ok" | "err" | "hang" | "throw" = "ok";
  /// How long each `duel_poll` takes to answer.
  pollDelayMs = 0;
  /// Every decoded request, in arrival order.
  requests: Array<{ sid: string; req: TransportRequest }> = [];
  polls = 0;
  /// Every `duel_request` call, thrown ones included.
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

  private _handle(sidArg: string, reqArg: TransportRequest): Reply {
    const [sid, req] = this._wire<[string, TransportRequest]>(
      [IDL.Text, this.types.TransportRequest],
      [sidArg, reqArg]
    );
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

  async duel_request(sid: string, req: TransportRequest): Promise<Reply> {
    this.attempts++;
    if (this.failRequests > 0) {
      this.failRequests--;
      if (this.landsBeforeFailing) this._handle(sid, req);
      throw new Error("network down");
    }
    return this._handle(sid, req);
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
