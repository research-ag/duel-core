// The transport `start()` requires: a `DuelTransport` speaking
// `mo:duel-game-core/transport`'s methods. The caller's principal is the
// player (the `sid` passed in is only this tab's label for it).
//
// Reading is by query only: `duel_lobby(rev)` (the open tables and the
// caller's own, `yours`) and `duel_table(tableId, rev)` (the caller's view
// of one table), each answering `unchanged` while the `rev` asked with is
// still current. The transport follows one table at a time — the newest
// of `yours` — or the lobby when there is none, and composes what it sees
// into the `Status` a client renders. A move is one `duel_submit` update
// whose reply is the table's fresh view; every other mutation
// (`duel_create_table`, ...) replies with an `Ack` (the table and its
// `rev`), after which the view is polled until it has caught up. A
// `#status` request is a resync by query. While the caller waits at a
// table for an opponent, `duel_keep_alive` keeps that table open.
//
//   const transport = connectTransport({ actor, gameIdlTypes: plugin.idlTypes });
//   start({ plugin, transport, session });
//
// `actor` is built from `makeIdlFactory(gameIdlTypes)`; `gameIdlTypes`
// is the same function, used to reject a malformed request before it is
// queued.
//
// Exposes `onopen`/`onmessage`/`onerror`/`onclose`/`send(msg)` plus
// `request(sid, req)` (a Promise of this call's own `{view}`/`{err}`),
// `onconnecting` (the link was lost and is being redone) and
// `queryStatus(sid)`. Requests go out one at a time, in order. Only
// `close()` ends it.

import { IDL } from "@icp-sdk/core/candid";
import {
  buildEngineTypes,
  type BuildGameTypes,
  type EngineTypes,
} from "./idl.js";
import type {
  Transport,
  EngineErr,
  Seat,
  Status,
  TableSummary,
  TransportPayload,
  TransportRequest,
  Visibility,
} from "./types.js";

const DEFAULT_INTERVAL_MS = 500;

/// How often a client waiting at a table for an opponent sends
/// `duel_keep_alive` (the canister's `KEEP_ALIVE_SECS`).
const DEFAULT_KEEP_ALIVE_MS = 20000;

/// A poll unanswered for this long counts as failed: the agent retries a
/// query that errors but never gives up on one that hangs.
const DEFAULT_POLL_TIMEOUT_MS = 3000;

/// Unanswered polls allowed at once: a call cannot be cancelled, so at
/// the limit the loop waits on the newest instead of asking again.
const MAX_OPEN_POLLS = 3;

/// Delays before resending a request whose update call threw.
const RESEND_DELAYS_MS = [500, 1500];

/// Delays between polls fetching an acked request's view while the
/// answering replica has not caught up with the ack's `rev` yet.
const FETCH_DELAYS_MS = [0, 100, 250, 500, 1000, 0];

/// Ceiling for the back-off between failed relinks.
const MAX_RETRY_MS = 5000;

/// The caller's view of one table (`TP.View<S>`), as the engine sends it.
type TableView = { [tag: string]: unknown };

/// Mirrors `Transport.Snapshot<S>`.
type Snapshot = { rev: bigint; view: TableView };

/// Mirrors `Transport.Reply<S>`.
export type Reply = { view: Snapshot } | { err: EngineErr };

/// Mirrors `Transport.Ack`.
export type Ack = { ok: { tableId: bigint; rev: bigint } } | { err: EngineErr };

/// Mirrors `Transport.TableResult<S>`.
export type TableResult = { unchanged: null } | { changed: Snapshot } | { gone: null };

/// Mirrors `Transport.LobbyResult`.
export type LobbyResult =
  | { unchanged: null }
  | { changed: { rev: bigint; tables: TableSummary[]; yours: bigint[] } };

/// The methods of a host wired with `mo:duel-game-core/transport`:
/// `duel_submit`/`duel_table` declared by the host, the rest from
/// `transport_actor_mixin`. The caller is the player.
export interface TransportActor {
  duel_create_table(seat: Seat, visibility: Visibility, variant: string): Promise<Ack>;
  duel_join_table(tableId: bigint, seat: Seat, code: [] | [string]): Promise<Ack>;
  duel_rematch(tableId: bigint): Promise<Ack>;
  duel_leave(tableId: bigint, gen: bigint): Promise<Ack>;
  duel_reset(tableId: bigint, gen: bigint): Promise<Ack>;
  duel_claim_win(tableId: bigint, gen: bigint): Promise<Ack>;
  duel_ack_ended(tableId: bigint): Promise<Ack>;
  duel_keep_alive(): Promise<{ ok: null } | { err: EngineErr }>;
  duel_submit(tableId: bigint, gen: bigint, turn: bigint, move: unknown): Promise<Reply>;
  duel_lobby(rev: bigint): Promise<LobbyResult>;
  duel_table(tableId: bigint, rev: bigint): Promise<TableResult>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const isStatus = (req: TransportRequest): boolean => "status" in req;

/// A view the caller sees as an outsider: the table is not (or no longer)
/// theirs, so the transport goes back to the lobby.
const isOutsider = (view: TableView): boolean => "lobby" in view || "busy" in view;

/// The table to follow among the caller's own: the newest.
const pick = (yours: bigint[]): bigint =>
  yours.reduce((a, b) => (b > a ? b : a));

const NOT_SEATED: EngineErr = { notSeated: null } as EngineErr;

export class DuelTransport extends EventTarget implements Transport {
  private _actor: TransportActor;
  private _types: EngineTypes;
  private _intervalMs: number;
  private _keepAliveMs: number;
  private _pollTimeoutMs: number;
  private _sid: string | null;
  // Bumped on every presumed loss, so a reply or poll from before it
  // cannot mark the new link up or down.
  private _epoch: number;
  // What the polls follow: a table, or the lobby (`null`), and the `rev`
  // last applied from it.
  private _focus: bigint | null;
  private _rev: bigint;
  // What was last delivered, and from which source (`undefined`: nothing).
  private _shown: bigint | null | undefined;
  private _last: TransportPayload | null;
  // A poll or reply succeeded under the current epoch and nothing
  // invalidated it.
  private _linked: boolean;
  private _closed: boolean;
  private _chain: Promise<void>; // serializes every request
  private _inFlight: number;
  private _statusQueued: boolean;
  private _lastKeepAlive: number;
  private _pollTimer: ReturnType<typeof setTimeout> | null;
  private _ticking: boolean;
  private _openPolls: number;
  private _lastPoll: Promise<void> | null;
  private _erroredSinceSuccess: boolean;
  private _consecutiveFailures: number;
  private _unlisten: Array<() => void>;

  onopen: (() => void) | null;
  onconnecting: (() => void) | null;
  onmessage: ((ev: { data: TransportPayload }) => void) | null;
  onerror: ((ev: { error?: Error }) => void) | null;
  onclose: (() => void) | null;

  constructor({
    actor,
    gameIdlTypes,
    intervalMs = DEFAULT_INTERVAL_MS,
    keepAliveMs = DEFAULT_KEEP_ALIVE_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  }: {
    actor: TransportActor;
    gameIdlTypes: BuildGameTypes;
    intervalMs?: number;
    keepAliveMs?: number;
    pollTimeoutMs?: number;
  }) {
    super();
    if (!actor) throw new Error("DuelTransport: `actor` is required");
    if (!gameIdlTypes)
      throw new Error("DuelTransport: `gameIdlTypes` is required");

    this._actor = actor;
    const { Action, State } = gameIdlTypes({ IDL });
    this._types = buildEngineTypes({ IDL, Action, State });
    this._intervalMs = intervalMs;
    this._keepAliveMs = keepAliveMs;
    this._pollTimeoutMs = pollTimeoutMs;
    this._sid = null;
    this._epoch = 0;
    this._focus = null;
    this._rev = 0n;
    this._shown = undefined;
    this._last = null;
    this._linked = false;
    this._closed = false;
    this._chain = Promise.resolve();
    this._inFlight = 0;
    this._statusQueued = false;
    this._lastKeepAlive = 0;
    this._pollTimer = null;
    this._ticking = false;
    this._openPolls = 0;
    this._lastPoll = null;
    this._erroredSinceSuccess = false;
    this._consecutiveFailures = 0;
    this._unlisten = [];

    this.onopen = null;
    this.onconnecting = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    this._schedule(0);

    // Nothing is sent on `pagehide`: a request issued during unload is
    // dropped by the browser, and silence is not a departure anyway.
    this._listen(globalThis, "pageshow", () => this._resume());
    this._listen(globalThis, "online", () => this._resume());
    if (typeof document !== "undefined") {
      this._listen(document, "visibilitychange", () => {
        if (document.visibilityState !== "hidden") this._resume();
      });
    }
  }

  private _listen(
    target: EventTarget | undefined,
    type: string,
    fn: (ev: Event) => void
  ): void {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, fn);
    this._unlisten.push(() => target.removeEventListener(type, fn));
  }

  /// Back from a gap: the next tick relinks, keeps alive or polls,
  /// whichever is due.
  private _resume(): void {
    if (this._closed) return;
    this._schedule(0);
  }

  /// The link is gone, or presumed gone: the next tick resyncs under a
  /// new epoch, and a caller that saw it open hears `onconnecting`.
  private _lose(): void {
    this._epoch++;
    if (!this._linked) return;
    this._linked = false;
    if (this.onconnecting) this.onconnecting();
    this.dispatchEvent(new Event("connecting"));
  }

  private _schedule(delay: number): void {
    if (this._closed) return;
    if (this._pollTimer != null) clearTimeout(this._pollTimer);
    this._pollTimer = setTimeout(() => this._tick(), delay);
  }

  /// Applies `status` from source `id` at `rev` and delivers it, unless
  /// it is not newer than what that same source already showed.
  private _show(id: bigint | null, rev: bigint, status: Status): void {
    if (this._shown === id && rev <= this._rev && this._last !== null) return;
    this._shown = id;
    this._rev = rev;
    this._last = { view: status };
    this._deliver(this._last);
  }

  /// Switches what the polls follow; the next poll asks it afresh.
  private _follow(id: bigint | null): void {
    if (this._focus === id) return;
    this._focus = id;
    this._rev = 0n;
  }

  /// One round of queries for the current focus: the table (falling back
  /// to the lobby when it is gone or no longer the caller's), or the
  /// lobby (moving on to the caller's newest table when there is one).
  private async _pollOnce(sid: string): Promise<void> {
    for (let hop = 0; hop < 3; hop++) {
      if (this._closed || sid !== this._sid) return;
      const id = this._focus;
      if (id === null) {
        const res = await this._actor.duel_lobby(this._rev);
        this._markAlive();
        if (this._focus !== null) return; // a request moved on meanwhile
        if ("unchanged" in res) return;
        const { rev, tables, yours } = res.changed;
        if (yours.length > 0) {
          this._follow(pick(yours));
          continue;
        }
        this._show(null, rev, { browsing: { tables } } as Status);
        return;
      }
      const res = await this._actor.duel_table(id, this._rev);
      this._markAlive();
      if (this._focus !== id) return; // a request moved on meanwhile
      if ("unchanged" in res) return;
      if ("gone" in res || isOutsider(res.changed.view)) {
        this._follow(null);
        continue;
      }
      this._show(id, res.changed.rev, { atTable: { id, view: res.changed.view } } as Status);
      return;
    }
  }

  /// One wait of `pollTimeoutMs` on a poll: a new one, or the newest
  /// while `MAX_OPEN_POLLS` are unanswered. A poll that outlives its wait
  /// still applies its answer.
  private _poll(sid: string): Promise<void> {
    if (this._lastPoll === null || this._openPolls < MAX_OPEN_POLLS) {
      this._openPolls++;
      const poll = this._pollOnce(sid).finally(() => {
        this._openPolls--;
      });
      poll.catch(() => {});
      this._lastPoll = poll;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("DuelTransport: poll timed out")),
        this._pollTimeoutMs
      );
    });
    return Promise.race([this._lastPoll, expired]).finally(() =>
      clearTimeout(timer)
    );
  }

  /// Whether the caller is waiting at a table for an opponent.
  private _waiting(): boolean {
    const last = this._last;
    if (last === null || !("view" in last)) return false;
    const st = last.view as { atTable?: { view: TableView } };
    return st.atTable !== undefined && "stagingYou" in st.atTable.view;
  }

  /// The one loop: relink if needed, keep a waiting table alive if due,
  /// poll. Two failed or expired waits in a row presume the link lost.
  private async _tick(): Promise<void> {
    if (this._closed || this._ticking) return;
    this._ticking = true;
    let delay = this._intervalMs;
    const sid = this._sid;
    if (sid !== null) {
      const idle = this._inFlight === 0;
      if (!this._linked) {
        if (idle) this._sendStatus(sid);
        delay = Math.min(
          MAX_RETRY_MS,
          this._intervalMs * 2 ** Math.min(4, this._consecutiveFailures)
        );
      } else {
        if (this._waiting() && Date.now() - this._lastKeepAlive >= this._keepAliveMs) {
          this._lastKeepAlive = Date.now();
          this._actor.duel_keep_alive().catch((e) => this._reportError(e as Error));
        }
        try {
          await this._poll(sid);
        } catch (e) {
          this._reportError(e as Error);
          if (this._consecutiveFailures >= 2) this._lose();
        }
      }
    }
    this._ticking = false;
    this._schedule(delay);
  }

  /// Throws on a request the IDL doesn't recognize.
  private _validate(req: TransportRequest): void {
    IDL.encode([this._types.TransportRequest], [req]);
  }

  /// The update call `req` maps to. Table requests name `id`, the table
  /// followed when the request was made (`joinTable` its own).
  private _dispatch(req: TransportRequest, id: bigint | null): Promise<Reply | Ack> {
    const a = this._actor;
    if ("createTable" in req) {
      const { seat, visibility, variant } = req.createTable;
      return a.duel_create_table(seat, visibility, variant);
    }
    if ("joinTable" in req) {
      const { id, seat, code } = req.joinTable;
      return a.duel_join_table(id, seat, code);
    }
    if (id === null) return Promise.resolve({ err: NOT_SEATED });
    if ("submit" in req) {
      const { gen, turn, move } = req.submit;
      return a.duel_submit(id, gen, turn, move);
    }
    if ("rematch" in req) return a.duel_rematch(id);
    if ("leave" in req) return a.duel_leave(id, req.leave.gen);
    if ("reset" in req) return a.duel_reset(id, req.reset.gen);
    if ("claimWin" in req) return a.duel_claim_win(id, req.claimWin.gen);
    return a.duel_ack_ended(id);
  }

  /// Polls until the view of table `id` has reached `minRev`, or the
  /// table is no longer the caller's (the transport has moved on to the
  /// lobby or another of their tables).
  private async _await(sid: string, id: bigint, minRev: bigint): Promise<TransportPayload> {
    this._follow(id);
    for (const delay of FETCH_DELAYS_MS) {
      if (this._closed) throw new Error("DuelTransport: closed");
      const caughtUp = this._shown === id && this._rev >= minRev;
      const movedOn = this._focus !== id && this._shown !== id && this._shown !== undefined;
      if ((caughtUp || movedOn) && this._last !== null) return this._last;
      if (delay > 0) await sleep(delay);
      await this._poll(sid);
    }
    throw new Error("DuelTransport: no view at the acked revision");
  }

  /// A resync by query: the lobby, then the caller's newest table.
  private async _resync(sid: string): Promise<TransportPayload> {
    this._follow(null);
    this._rev = 0n;
    this._shown = this._shown === null ? undefined : this._shown;
    await this._poll(sid);
    if (this._last === null) throw new Error("DuelTransport: no status");
    return this._last;
  }

  /// One request. An update call is resent when it throws: it may or may
  /// not have landed, and every mutation is gated by the engine's own
  /// legality/idempotency checks. An `Ack` is followed by fetching the
  /// view it promises, which is not resent with the call.
  private async _call(
    sid: string,
    req: TransportRequest
  ): Promise<{ payload: TransportPayload; resent: boolean }> {
    const epoch = this._epoch;
    if (isStatus(req)) {
      try {
        const payload = await this._resync(sid);
        if (epoch === this._epoch) this._markLinked();
        return { payload, resent: false };
      } catch (e) {
        this._reportError(e as Error);
        this._lose();
        throw e;
      }
    }
    // A resend goes to the same table, whatever the polls follow by then.
    const target = this._focus;
    for (let attempt = 0; ; attempt++) {
      if (this._closed) throw new Error("DuelTransport: closed");
      let res: Reply | Ack;
      try {
        res = await this._dispatch(req, target);
      } catch (e) {
        this._reportError(e as Error);
        if (attempt >= RESEND_DELAYS_MS.length) {
          this._lose();
          throw e;
        }
        await sleep(RESEND_DELAYS_MS[attempt]);
        continue;
      }
      this._markAlive();
      if ("err" in res) return { payload: { err: res.err }, resent: attempt > 0 };
      let payload: TransportPayload;
      if ("ok" in res) {
        try {
          payload = await this._await(sid, res.ok.tableId, res.ok.rev);
        } catch (e) {
          this._reportError(e as Error);
          this._lose();
          throw e;
        }
      } else {
        // `duel_submit`'s own view of the table it was about.
        const id = target as bigint;
        this._follow(id);
        this._show(id, res.view.rev, { atTable: { id, view: res.view.view } } as Status);
        payload = this._last as TransportPayload;
      }
      if (epoch === this._epoch) this._markLinked();
      return { payload, resent: attempt > 0 };
    }
  }

  /// `#alreadySubmitted`/`#stale` on a resent mutation can only mean the
  /// original already landed; settle with a resync instead of an error
  /// that would make a successful click look failed.
  private async _exchange(sid: string, req: TransportRequest): Promise<TransportPayload> {
    let { payload, resent } = await this._call(sid, req);
    if (
      resent &&
      "err" in payload &&
      ("alreadySubmitted" in payload.err || "stale" in payload.err)
    ) {
      ({ payload } = await this._call(sid, { status: null }));
    }
    if ("err" in payload) this._deliver(payload);
    return payload;
  }

  private _enqueue(sid: string, req: TransportRequest): Promise<TransportPayload> {
    // Throws on a request the IDL doesn't recognize (a tampered
    // `data-act`), before anything is queued.
    this._validate(req);
    this._sid = sid;
    this._inFlight++;
    const result = this._chain.then(() => this._exchange(sid, req));
    this._chain = result.then(
      () => {},
      () => {}
    );
    void this._chain.then(() => {
      this._inFlight--;
    });
    return result;
  }

  private _sendStatus(sid: string): void {
    if (this._statusQueued) return;
    this._statusQueued = true;
    this._enqueue(sid, { status: null }).then(
      () => {
        this._statusQueued = false;
      },
      () => {
        this._statusQueued = false;
      }
    );
  }

  private _markLinked(): void {
    if (this._linked) return;
    this._linked = true;
    // Fires on EVERY confirmed (re)link — `onopen` is the caller's only
    // hook to resync after a gap.
    if (this.onopen) this.onopen();
    this.dispatchEvent(new Event("open"));
  }

  /// Fire-and-forget: the result only ever surfaces as a `message`/`error`
  /// event. Safe at any time; it waits its turn behind earlier requests.
  send(msg: { req?: { sid: string; req: TransportRequest } }): void {
    if (this._closed) return;
    const envelope = msg?.req;
    if (!envelope) return;
    const { sid, req } = envelope;
    if (isStatus(req)) {
      // Coalesced with one already on its way (a relink's own, then the
      // caller's resync).
      this._sid = sid;
      this._sendStatus(sid);
      return;
    }
    try {
      this._enqueue(sid, req).catch(() => {});
    } catch (e) {
      this._reportError(e as Error);
    }
  }

  /// Resolves with THIS call's own `{view}`/`{err}`; rejects when the
  /// update call kept failing.
  request(sid: string, req: TransportRequest): Promise<TransportPayload> {
    if (this._closed) return Promise.reject(new Error("DuelTransport: closed"));
    try {
      return this._enqueue(sid, req);
    } catch (e) {
      return Promise.reject(e as Error);
    }
  }

  /// The caller's status by query alone — the lobby, then their newest
  /// table — without touching the link: a first paint.
  async queryStatus(_sid: string): Promise<Status> {
    const lobby = await this._actor.duel_lobby(0n);
    if (!("changed" in lobby)) throw new Error("DuelTransport: no lobby");
    const { tables, yours } = lobby.changed;
    if (yours.length > 0) {
      const id = pick(yours);
      const t = await this._actor.duel_table(id, 0n);
      if ("changed" in t && !isOutsider(t.changed.view)) {
        return { atTable: { id, view: t.changed.view } } as Status;
      }
    }
    return { browsing: { tables } } as Status;
  }

  get closed(): boolean {
    return this._closed;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    if (this._pollTimer != null) clearTimeout(this._pollTimer);
    for (const off of this._unlisten) off();
    this._unlisten = [];
    if (this.onclose) this.onclose();
    this.dispatchEvent(new Event("close"));
  }

  private _deliver(data: TransportPayload): void {
    if (this._closed) return;
    if (this.onmessage) this.onmessage({ data });
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  private _markAlive(): void {
    this._erroredSinceSuccess = false;
    this._consecutiveFailures = 0;
  }

  // `onerror` fires only on a second consecutive failure: a lone blip
  // self-heals within a tick.
  private _reportError(e: Error): void {
    console.debug("[duel-transport] error:", e && e.message ? e.message : e);
    this._consecutiveFailures++;
    if (this._consecutiveFailures < 2) return;
    if (this._erroredSinceSuccess) return;
    this._erroredSinceSuccess = true;
    if (this.onerror) this.onerror({ error: e });
    this.dispatchEvent(new Event("error"));
  }
}

/// `intervalMs` (default 500) is the poll interval; `keepAliveMs` (default
/// 20000) how often a waiting table is kept open; `pollTimeoutMs`
/// (default 3000) how long one poll may go unanswered.
export function connectTransport(opts: {
  actor: TransportActor;
  gameIdlTypes: BuildGameTypes;
  intervalMs?: number;
  keepAliveMs?: number;
  pollTimeoutMs?: number;
}): DuelTransport {
  return new DuelTransport(opts);
}
