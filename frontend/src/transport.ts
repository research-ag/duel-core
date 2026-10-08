// The transport `start()` requires: a `DuelTransport` speaking
// `mo:duel-game-core/transport`'s methods. A move is one `duel_submit`
// update call whose reply is this session's fresh status. Every other
// request (`duel_create_table`, ..., `duel_ping` for `#status`) replies
// with an `Ack` carrying the session's `rev` after the call, and the view
// is then fetched with `duel_poll(sid, 0)`, accepted once its `rev` has
// caught up. Everything the other seat causes arrives by polling
// `duel_poll`. There is no other transport.
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
// `close()` ends it: anything the canister forgets (an upgrade, a pruned
// link) is relinked with a `#status`.

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
  TransportPayload,
  TransportRequest,
  Visibility,
} from "./types.js";

const DEFAULT_INTERVAL_MS = 500;

/// A `#status` goes out after this long without any other request; the
/// canister's `PRESENCE_TTL_NS` (180s) is what it keeps alive.
const DEFAULT_PING_MS = 120000;

/// A `duel_poll` unanswered for this long counts as failed: the agent
/// retries a query that errors but never gives up on one that hangs.
const DEFAULT_POLL_TIMEOUT_MS = 3000;

/// Unanswered polls allowed at once: a call cannot be cancelled, so at
/// the limit the loop waits on the newest instead of asking again.
const MAX_OPEN_POLLS = 3;

/// Delays before resending a request whose update call threw.
const RESEND_DELAYS_MS = [500, 1500];

/// Delays between `duel_poll`s fetching an acked request's view while the
/// answering replica has not caught up with the ack's `rev` yet.
const FETCH_DELAYS_MS = [0, 100, 250, 500, 1000, 0];

/// Ceiling for the back-off between failed relinks.
const MAX_RETRY_MS = 5000;

type View = { rev: bigint; view: Status };

/// Mirrors `Transport.PollResult<S>`.
export type PollResult =
  { unchanged: null } | { changed: View } | { unknown: null };

/// Mirrors `Transport.Reply<S>`.
type Reply = { view: View } | { err: EngineErr };

/// Mirrors `Transport.Ack`.
export type Ack = { ok: { rev: bigint } } | { err: EngineErr };

/// The methods of a host wired with `mo:duel-game-core/transport`:
/// `duel_submit`/`duel_poll` declared by the host, the rest from
/// `transport_actor_mixin`.
export interface TransportActor {
  duel_create_table(sid: string, seat: Seat, visibility: Visibility, variant: string): Promise<Ack>;
  duel_join_table(sid: string, id: bigint, seat: Seat, code: [] | [string]): Promise<Ack>;
  duel_rematch(sid: string): Promise<Ack>;
  duel_leave(sid: string, gen: bigint): Promise<Ack>;
  duel_reset(sid: string, gen: bigint): Promise<Ack>;
  duel_claim_win(sid: string, gen: bigint): Promise<Ack>;
  duel_ack_ended(sid: string): Promise<Ack>;
  duel_ping(sid: string): Promise<Ack>;
  duel_submit(sid: string, gen: bigint, turn: bigint, move: unknown): Promise<Reply>;
  duel_poll(sid: string, rev: bigint): Promise<PollResult>;
  /// The host's plain `status` query, when the actor declares it.
  status?(sid: string): Promise<Status>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const isStatus = (req: TransportRequest): boolean => "status" in req;

export class DuelTransport extends EventTarget implements Transport {
  private _actor: TransportActor;
  private _types: EngineTypes;
  private _intervalMs: number;
  private _pingMs: number;
  private _pollTimeoutMs: number;
  private _sid: string | null;
  // Bumped on every presumed loss, so a reply or poll from before it
  // cannot mark the new link up or down.
  private _epoch: number;
  // The newest revision applied, and the payload it carried.
  private _rev: bigint;
  private _last: TransportPayload | null;
  // A reply arrived under the current epoch and nothing invalidated it.
  private _linked: boolean;
  private _closed: boolean;
  private _chain: Promise<void>; // serializes every update call
  private _inFlight: number;
  private _statusQueued: boolean;
  private _lastRequestAt: number;
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
    pingMs = DEFAULT_PING_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  }: {
    actor: TransportActor;
    gameIdlTypes: BuildGameTypes;
    intervalMs?: number;
    pingMs?: number;
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
    this._pingMs = pingMs;
    this._pollTimeoutMs = pollTimeoutMs;
    this._sid = null;
    this._epoch = 0;
    this._rev = 0n;
    this._last = null;
    this._linked = false;
    this._closed = false;
    this._chain = Promise.resolve();
    this._inFlight = 0;
    this._statusQueued = false;
    this._lastRequestAt = 0;
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

  /// Back from a gap: the next tick relinks, pings or polls, whichever
  /// is due.
  private _resume(): void {
    if (this._closed) return;
    this._schedule(0);
  }

  /// The link is gone, or presumed gone: the next tick sends a `#status`
  /// under a new epoch, and a caller that saw it open hears `onconnecting`.
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

  /// One wait of `pollTimeoutMs` on a poll: a new one, or the newest
  /// while `MAX_OPEN_POLLS` are unanswered. A poll that outlives its wait
  /// still applies its answer.
  private _poll(sid: string): Promise<void> {
    if (this._lastPoll === null || this._openPolls < MAX_OPEN_POLLS) {
      const epoch = this._epoch;
      this._openPolls++;
      const poll = (async () => this._actor.duel_poll(sid, this._rev))()
        .finally(() => {
          this._openPolls--;
        })
        .then((res) => this._applyPoll(sid, epoch, res));
      poll.catch(() => {});
      this._lastPoll = poll;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("DuelTransport: duel_poll timed out")),
        this._pollTimeoutMs
      );
    });
    return Promise.race([this._lastPoll, expired]).finally(() =>
      clearTimeout(timer)
    );
  }

  private _applyPoll(sid: string, epoch: number, res: PollResult): void {
    if (this._closed || sid !== this._sid) return;
    this._markAlive();
    if ("changed" in res) {
      const { rev, view } = res.changed;
      if (rev > this._rev) {
        this._rev = rev;
        this._last = { view };
        this._deliver(this._last);
      }
    } else if ("unknown" in res && this._linked && epoch === this._epoch) {
      this._lose();
    }
  }

  /// The one loop: relink if needed, ping if due, else poll. Two failed
  /// or expired waits in a row presume the link lost.
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
        if (idle && Date.now() - this._lastRequestAt >= this._pingMs)
          this._sendStatus(sid);
        try {
          await this._poll(sid);
          if (!this._linked) delay = 0;
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

  /// The update call `req` maps to.
  private _dispatch(sid: string, req: TransportRequest): Promise<Reply | Ack> {
    const a = this._actor;
    if ("submit" in req) {
      const { gen, turn, move } = req.submit;
      return a.duel_submit(sid, gen, turn, move);
    }
    if ("createTable" in req) {
      const { seat, visibility, variant } = req.createTable;
      return a.duel_create_table(sid, seat, visibility, variant);
    }
    if ("joinTable" in req) {
      const { id, seat, code } = req.joinTable;
      return a.duel_join_table(sid, id, seat, code);
    }
    if ("rematch" in req) return a.duel_rematch(sid);
    if ("leave" in req) return a.duel_leave(sid, req.leave.gen);
    if ("reset" in req) return a.duel_reset(sid, req.reset.gen);
    if ("claimWin" in req) return a.duel_claim_win(sid, req.claimWin.gen);
    if ("ackEnded" in req) return a.duel_ack_ended(sid);
    return a.duel_ping(sid);
  }

  /// An acked request's view: the one already applied when it is at
  /// least `minRev` new, else whatever the regular poll (same timeout,
  /// same cap on unanswered polls) brings in. A replica that has not
  /// caught up with `minRev` yet is asked again.
  private async _fetchView(sid: string, minRev: bigint): Promise<View> {
    for (const delay of FETCH_DELAYS_MS) {
      if (this._closed) throw new Error("DuelTransport: closed");
      if (this._rev >= minRev && this._last !== null && "view" in this._last) {
        return { rev: this._rev, view: this._last.view };
      }
      if (delay > 0) await sleep(delay);
      await this._poll(sid);
    }
    throw new Error("DuelTransport: no view at the acked revision");
  }

  /// One update call, resent when it throws: the call may or may not have
  /// landed, and every mutation is gated by the engine's own
  /// legality/idempotency checks. An `Ack` is followed by fetching the
  /// view it promises, which is not resent with the call.
  private async _call(
    sid: string,
    req: TransportRequest
  ): Promise<{ reply: Reply; resent: boolean }> {
    for (let attempt = 0; ; attempt++) {
      if (this._closed) throw new Error("DuelTransport: closed");
      // A loss presumed while this attempt was out must not be undone
      // by its reply.
      const epoch = this._epoch;
      let res: Reply | Ack;
      try {
        this._lastRequestAt = Date.now();
        res = await this._dispatch(sid, req);
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
      let reply: Reply;
      if ("ok" in res) {
        try {
          reply = { view: await this._fetchView(sid, res.ok.rev) };
        } catch (e) {
          this._reportError(e as Error);
          this._lose();
          throw e;
        }
      } else {
        reply = res;
      }
      if ("view" in reply && epoch === this._epoch) this._markLinked();
      return { reply, resent: attempt > 0 };
    }
  }

  /// Applies a reply in revision order and returns what the caller should
  /// see: a view not newer than one already applied yields that one,
  /// undelivered again (an acked request's view arrives through the poll).
  private _apply(reply: Reply): { payload: TransportPayload; fresh: boolean } {
    if ("err" in reply) return { payload: { err: reply.err }, fresh: true };
    if (reply.view.rev <= this._rev && this._last !== null) {
      return { payload: this._last, fresh: false };
    }
    this._rev = reply.view.rev;
    this._last = { view: reply.view.view };
    return { payload: this._last, fresh: true };
  }

  /// `#alreadySubmitted`/`#stale` on a resent mutation can only mean the
  /// original already landed; settle with a fresh `#status` instead of an
  /// error that would make a successful click look failed.
  private async _exchange(sid: string, req: TransportRequest): Promise<TransportPayload> {
    let { reply, resent } = await this._call(sid, req);
    if (
      resent &&
      "err" in reply &&
      ("alreadySubmitted" in reply.err || "stale" in reply.err)
    ) {
      ({ reply } = await this._call(sid, { status: null }));
    }
    const { payload, fresh } = this._apply(reply);
    if (fresh) this._deliver(payload);
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

  /// The host's plain `status` query: a first paint while the first
  /// `#status` is still on its way. Rejects when the actor declares none.
  queryStatus(sid: string): Promise<Status> {
    if (typeof this._actor.status !== "function") {
      return Promise.reject(
        new Error("DuelTransport: the actor declares no `status` query")
      );
    }
    return this._actor.status(sid);
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

/// `intervalMs` (default 500) is the poll interval; `pingMs` (default
/// 120000) is how long the link may stay quiet before a `#status`;
/// `pollTimeoutMs` (default 3000) is how long one poll may go unanswered.
export function connectTransport(opts: {
  actor: TransportActor;
  gameIdlTypes: BuildGameTypes;
  intervalMs?: number;
  pingMs?: number;
  pollTimeoutMs?: number;
}): DuelTransport {
  return new DuelTransport(opts);
}
