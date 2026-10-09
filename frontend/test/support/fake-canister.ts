// A tiny in-memory stand-in for a canister wired with
// `mo:duel-game-core/transport`. Its state is one composed `Status`:
// `atTable` means the caller has that one table (`duel_lobby` lists it in
// `yours`, `duel_table` serves its view); `browsing` means none (every
// table is `gone`). One revision counter versions it all. Mutations reply
// with an `Ack`, `duel_submit` with the table's view.

import { IDL } from "@icp-sdk/core/candid";
import { buildEngineTypes, type EngineTypes } from "../../src/idl.js";
import type {
  Ack,
  LobbyResult,
  Reply,
  TableResult,
  TransportActor,
} from "../../src/transport.js";
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

type AtTable = { atTable: { id: bigint; view: unknown } };

export class FakeCanister implements TransportActor {
  private types: EngineTypes;
  rev = 1n;
  current: Status = ENDED;

  /// What to answer the next mutation with. Override per test.
  respond: (req: TransportRequest) => { view: Status } | { err: EngineErr } = () => ({
    view: this.current,
  });
  /// How many upcoming update calls throw before one lands.
  failRequests = 0;
  /// Whether a throwing update call still applies the request.
  landsBeforeFailing = false;
  pollBehavior: "ok" | "err" | "hang" | "throw" = "ok";
  /// How long each query takes to answer.
  pollDelayMs = 0;
  /// Every mutation, in arrival order (thrown ones that landed included).
  sent: TransportRequest[] = [];
  /// Queries asked (`duel_lobby` and `duel_table`).
  polls = 0;
  /// Every update call, thrown ones included.
  attempts = 0;
  keepAlives = 0;

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

  /// Test-only: the other seat acted — a new revision for the next poll.
  push(view: Status): void {
    this.current = view;
    this.rev++;
  }

  private _table(): AtTable["atTable"] | null {
    return "atTable" in this.current ? (this.current as AtTable).atTable : null;
  }

  private _apply(req: TransportRequest): { view: Status } | { err: EngineErr } {
    this.sent.push(req);
    const r = this.respond(req);
    if ("view" in r) {
      this.current = r.view;
      this.rev++;
    }
    return r;
  }

  private _update(req: TransportRequest): { view: Status } | { err: EngineErr } {
    this.attempts++;
    if (this.failRequests > 0) {
      this.failRequests--;
      if (this.landsBeforeFailing) this._apply(req);
      throw new Error("network down");
    }
    return this._apply(req);
  }

  private async _acked(req: TransportRequest, tableId: bigint): Promise<Ack> {
    const r = this._update(req);
    const t = this._table();
    const ack: Ack = "err" in r ? { err: r.err } : { ok: { tableId: t ? t.id : tableId, rev: this.rev } };
    return this._wire<[Ack]>([this.types.Ack], [ack])[0];
  }

  async duel_submit(tableId: bigint, gen: bigint, turn: bigint, move: unknown): Promise<Reply> {
    const [, g, t, m] = this._wire<[bigint, bigint, bigint, unknown]>(
      [IDL.Nat, IDL.Nat, IDL.Nat, sampleGameTypes({ IDL }).Action],
      [tableId, gen, turn, move]
    );
    const r = this._update({ submit: { gen: g, turn: t, move: m } });
    const table = this._table();
    const reply: Reply = "err" in r
      ? { err: r.err }
      : table
        ? { view: { rev: this.rev, view: table.view as never } }
        : { err: { noSuchTable: null } as EngineErr };
    return this._wire<[Reply]>([this.types.TransportReply], [reply])[0];
  }
  duel_create_table(seat: Seat, visibility: Visibility, variant: string): Promise<Ack> {
    return this._acked({ createTable: { seat, visibility, variant } }, 1n);
  }
  duel_join_table(tableId: bigint, seat: Seat, code: [] | [string]): Promise<Ack> {
    return this._acked({ joinTable: { id: tableId, seat, code } }, tableId);
  }
  duel_rematch(tableId: bigint): Promise<Ack> {
    return this._acked({ rematch: null }, tableId);
  }
  duel_leave(tableId: bigint, gen: bigint): Promise<Ack> {
    return this._acked({ leave: { gen } }, tableId);
  }
  duel_reset(tableId: bigint, gen: bigint): Promise<Ack> {
    return this._acked({ reset: { gen } }, tableId);
  }
  duel_claim_win(tableId: bigint, gen: bigint): Promise<Ack> {
    return this._acked({ claimWin: { gen } }, tableId);
  }
  duel_ack_ended(tableId: bigint): Promise<Ack> {
    return this._acked({ ackEnded: null }, tableId);
  }
  async duel_keep_alive(): Promise<{ ok: null } | { err: EngineErr }> {
    this.keepAlives++;
    return { ok: null };
  }

  private async _query<T>(answer: () => T): Promise<T> {
    this.polls++;
    if (this.pollBehavior === "throw") throw new Error("not async");
    await Promise.resolve();
    if (this.pollBehavior === "err") throw new Error("unavailable");
    if (this.pollBehavior === "hang") return new Promise(() => {});
    if (this.pollDelayMs > 0) await new Promise((r) => setTimeout(r, this.pollDelayMs));
    return answer();
  }

  duel_lobby(rev: bigint): Promise<LobbyResult> {
    if (this.pollBehavior === "throw") {
      this.polls++;
      throw new Error("not async");
    }
    return this._query(() => {
      if (rev !== 0n && rev === this.rev) return { unchanged: null };
      const t = this._table();
      const res: LobbyResult = {
        changed: {
          rev: this.rev,
          tables: t ? [] : (this.current as { browsing: { tables: [] } }).browsing.tables,
          yours: t ? [t.id] : [],
        },
      };
      return this._wire<[LobbyResult]>([this.types.LobbyResult], [res])[0];
    });
  }

  duel_table(tableId: bigint, rev: bigint): Promise<TableResult> {
    if (this.pollBehavior === "throw") {
      this.polls++;
      throw new Error("not async");
    }
    return this._query(() => {
      const t = this._table();
      if (!t || t.id !== tableId) return { gone: null };
      if (rev !== 0n && rev === this.rev) return { unchanged: null };
      const res: TableResult = { changed: { rev: this.rev, view: t.view as never } };
      return this._wire<[TableResult]>([this.types.TableResult], [res])[0];
    });
  }
}
