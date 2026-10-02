// The headless client: everything a duel-game-core game client does that
// is not drawing. It owns the `ws`, the current `Status`, the one call in
// flight, error lifetime, the session-identity lock, and the stale-view
// resync, and publishes an immutable `ClientState` snapshot to subscribers.
// No DOM, no storage, no HTML; `app.ts`'s `start()` is one UI over it and
// a game with its own screens binds this the same way. See ../README.md,
// "The headless client".

import type {
  DuelWs,
  EngineErr,
  InGameView,
  Seat,
  SeatTag,
  StagingYouView,
  Status,
  View,
  Visibility,
  WsPayload,
  WsRequest,
} from "./types.js";

export function tag(v: object): string {
  return Object.keys(v)[0];
}

export function val(v: object): unknown {
  return Object.values(v as Record<string, unknown>)[0];
}

/// Structural equality for decoded Candid values. Not `JSON.stringify`:
/// `bigint` fields would throw.
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a === null || b === null) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) =>
      Object.hasOwn(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/// Text for every engine-level `Err`; a game's own `illegalMove` reason
/// is already free text.
export function errText(e: EngineErr): string {
  const t = tag(e);
  const v = val(e);
  switch (t) {
    case "seatTaken":
      return "That seat is already taken.";
    case "notSeated":
      return "You are not seated in this game.";
    case "alreadySubmitted":
      return "You have already moved this round.";
    case "notYourTurn":
      return "It's not your turn.";
    case "illegalMove":
      return v as string;
    case "wrongPhase":
      return v as string;
    case "reserved":
      return `That seat is held for a rematch — ${(v as { secondsLeft: bigint }).secondsLeft}s left.`;
    case "notIdle":
      return `The board is in use — ${(v as { secondsLeft: bigint }).secondsLeft}s until it can be taken over.`;
    case "notOverdue":
      return `Your opponent hasn't gone quiet long enough yet — ${(v as { secondsLeft: bigint }).secondsLeft}s left before you can claim the win.`;
    case "noSuchTable":
      return "That table doesn't exist any more.";
    case "badCode":
      return "Wrong (or missing) access code for that table.";
    case "unauthorized":
      return "This session belongs to a different signed-in identity.";
    default:
      return t;
  }
}

// ── Status selectors ────────────────────────────────────────────────────

export function atTableOf<S>(status: Status<S> | null): { id: bigint; view: View<S> } | null {
  if (status == null) return null;
  if (tag(status) !== "atTable") return null;
  return val(status) as { id: bigint; view: View<S> };
}

/// The per-table view's tag (`"inGame"`, ...) or `"browsing"`.
export function viewTagOf<S>(status: Status<S> | null): string | null {
  if (status == null) return null;
  const at = atTableOf(status);
  return at === null ? "browsing" : tag(at.view);
}

/// The per-table view under `viewTag`, or `null` when the status is
/// anything else: `viewOf<InGameView>(status, "inGame")`.
export function viewOf<V>(status: Status | null, viewTag: string): V | null {
  const at = atTableOf(status);
  if (at === null || tag(at.view) !== viewTag) return null;
  return val(at.view) as V;
}

/// Swapping identity while holding one of these seats would abandon it.
const SEATED_VIEW_TAGS = new Set(["stagingYou", "inGame", "debrief"]);

export function isSeated(status: Status | null): boolean {
  const t = viewTagOf(status);
  return t !== null && SEATED_VIEW_TAGS.has(t);
}

/// `0n` outside a live phase; the engine rejects it as `#stale`.
export function genOf(status: Status | null): bigint {
  const at = atTableOf(status);
  if (!at) return 0n;
  const t = tag(at.view);
  if (t === "stagingYou" || t === "inGame" || t === "debrief" || t === "awaitingRematch") {
    return (val(at.view) as { gen: bigint }).gen;
  }
  return 0n;
}

export function turnOf(status: Status | null): bigint {
  const inGame = viewOf<InGameView>(status, "inGame");
  return inGame ? inGame.turn : 0n;
}

export function oppSeatOf(seat: SeatTag): SeatTag {
  return seat === "p1" ? "p2" : "p1";
}

/// The claim clock seen from two roles: `"waiting"` (my move is in, the
/// opponent's is overdue: offers the claim) and `"atRisk"` (the mirror).
export function claimRoleOf(v: InGameView): "waiting" | "atRisk" | null {
  if (v.youSubmitted) return v.oppSubmitted ? null : "waiting";
  return v.oppSubmitted ? "atRisk" : null;
}

/// A pushed `secondsUntilX` counted down locally from the moment the
/// status arrived (`ClientState.statusAt`). Never below zero.
export function localSecondsLeft(pushedSecs: bigint, statusAtMs: number, nowMs = Date.now()): bigint {
  const elapsed = BigInt(Math.max(0, Math.floor((nowMs - statusAtMs) / 1000)));
  return pushedSecs > elapsed ? pushedSecs - elapsed : 0n;
}

/// A pushed `waitingSecs` counted UP locally.
export function localSecondsElapsed(pushedSecs: bigint, statusAtMs: number, nowMs = Date.now()): bigint {
  return pushedSecs + BigInt(Math.max(0, Math.floor((nowMs - statusAtMs) / 1000)));
}

// ── The client ──────────────────────────────────────────────────────────

/// The minimal identity a client needs; `identity.js`'s `ResolvedIdentity`
/// and `anon-identity.js`'s lighter result both satisfy it.
export interface SessionIdentity {
  sid: string;
  isLoggedIn?: boolean;
  regenerate?(): Promise<void>;
  login?(): Promise<void>;
  logout?(): Promise<void>;
}

/// `"reconnecting"`: was open, lost it, redoing it (calls queue behind
/// the reopen); `"closed"`: over for good.
export type Connection = "connecting" | "open" | "reconnecting" | "closed";

/// The one call in flight. `key` names what it does (`create:p1`,
/// `jointable:3:p2`, `act:{"pass":null}`, `rematch`, `leave`, `reset`,
/// `claim-win`, `ack`) so a UI can mark the control that issued it.
export interface PendingCall {
  key: string;
  req: WsRequest;
}

/// The move a pending `submit` carries, or null for any other call.
export function pendingMoveOf<A = unknown>(pending: PendingCall | null): A | null {
  return pending !== null && "submit" in pending.req ? (pending.req.submit.move as A) : null;
}

/// `status` as it will look once the pending `submit` lands: the board
/// through `applyLocal`, and the seat flipped to waiting. Unchanged when
/// nothing is pending, `applyLocal` returns null, or `status` already moved
/// past the view the move was stamped against (gen/turn changed, or the
/// move is already in). Display only — calls keep reading the real status.
/// See ../README.md, "Showing moves".
export function withLocalMove<S, A = unknown>(
  status: Status<S> | null,
  pending: PendingCall | null,
  applyLocal: ((gameState: S, mySeat: SeatTag, move: A) => S | null) | undefined,
): Status<S> | null {
  if (!applyLocal || pending === null || !("submit" in pending.req)) return status;
  const at = atTableOf(status);
  const v = viewOf<InGameView<S>>(status, "inGame");
  if (at === null || v === null || v.youSubmitted) return status;
  const { gen, turn, move } = pending.req.submit;
  if (v.gen !== gen || v.turn !== turn) return status;
  const game = applyLocal(v.game, tag(v.seat) as SeatTag, move as A);
  if (game === null) return status;
  const alternating = "alternating" in v.mode;
  const local: InGameView<S> = {
    ...v,
    game,
    turn: alternating ? v.turn + 1n : v.turn,
    youSubmitted: true,
    oppSubmitted: alternating ? false : v.oppSubmitted,
    claimWinAvailable: false,
    secondsUntilClaimable: v.claimTimeoutSecs,
  };
  return { atTable: { id: at.id, view: { inGame: local } } };
}

export interface ClientState<S = unknown> {
  connection: Connection;
  /// The last status received (the first may come from `ws.queryStatus`
  /// while still `"connecting"`); `null` until one lands.
  status: Status<S> | null;
  /// `Date.now()` when `status` last changed. Every `secondsUntilX` field
  /// is only as fresh as that moment; see `localSecondsLeft`.
  statusAt: number;
  pending: PendingCall | null;
  /// A transient message (cleared after `errorTtlMs`), or the permanent
  /// "Connection closed." once `connection` is `"closed"`.
  error: string | null;
  /// A `login`/`logout`/`regenerateSid` is under way (each reloads the
  /// page on success, so this only ever clears on failure).
  authPending: boolean;
  /// Switching identity now would abandon a seat or a join in flight, or
  /// the connection is closed, or an identity change is already under
  /// way: a UI disables its "new sid" and login/logout controls.
  identityLocked: boolean;
}

export type CallOutcome<S = unknown> =
  | { ok: true; view: Status<S> }
  | { ok: false; reason: "inFlight" | "closed" }
  /// The engine rejected it; `message` is what `state.error` shows.
  | { ok: false; reason: "rejected"; err: EngineErr; message: string }
  /// The transport failed; `message` is what `state.error` shows.
  | { ok: false; reason: "failed"; message: string }
  /// A `#wrongPhase` create/join or a `#stale` mutation: this tab's view
  /// was behind, a silent `refresh()` is on its way, nothing is shown.
  | { ok: false; reason: "stale" };

export type Listener<S> = (state: ClientState<S>, prev: ClientState<S>) => void;

export interface DuelClient<S = unknown, A = unknown> {
  readonly sid: string;
  readonly session: SessionIdentity;
  getState(): ClientState<S>;
  /// Called synchronously after every change, with the new and previous
  /// snapshots. Returns the unsubscribe function.
  subscribe(listener: Listener<S>): () => void;

  createTable(seat: SeatTag, visibility?: Visibility, variant?: string): Promise<CallOutcome<S>>;
  joinTable(id: bigint, seat: SeatTag, code?: string | null): Promise<CallOutcome<S>>;
  submit(move: A): Promise<CallOutcome<S>>;
  rematch(): Promise<CallOutcome<S>>;
  leave(): Promise<CallOutcome<S>>;
  reset(): Promise<CallOutcome<S>>;
  claimWin(): Promise<CallOutcome<S>>;
  ackEnded(): Promise<CallOutcome<S>>;
  /// A sync ping, never a mutation: no `pending`, ignored while one is.
  refresh(): void;

  /// Puts a message of the UI's own into `state.error` on the same
  /// lifetime as an engine rejection.
  showError(message: string): void;
  clearError(): void;

  /// Each resolves once the session's own call resolves; a rejection is
  /// shown via `state.error` and `authPending` drops back. A missing
  /// `session.login`/`logout`/`regenerate` is a no-op.
  login(): Promise<void>;
  logout(): Promise<void>;
  regenerateSid(): Promise<void>;

  /// Detaches from `ws` and stops the error timer.
  dispose(): void;
}

export interface ClientOptions<S = unknown> {
  ws: DuelWs<S>;
  session: SessionIdentity;
  /// How long a transient error stays in `state.error`; default 5000, 0
  /// keeps it until `clearError()` or the next error.
  errorTtlMs?: number;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  } catch {
    return "?";
  }
}

/// The `PendingCall.key` a request gets. Stable across a redraw, so a UI
/// can find the equivalent control on brand-new DOM nodes.
export function pendingKeyOf(req: WsRequest): string {
  if ("createTable" in req) return `create:${tag(req.createTable.seat)}`;
  if ("joinTable" in req) return `jointable:${req.joinTable.id}:${tag(req.joinTable.seat)}`;
  if ("submit" in req) return `act:${safeJson(req.submit.move)}`;
  if ("rematch" in req) return "rematch";
  if ("leave" in req) return "leave";
  if ("reset" in req) return "reset";
  if ("claimWin" in req) return "claim-win";
  if ("ackEnded" in req) return "ack";
  return "";
}

// A `#wrongPhase` on create/join means this tab's view is stale (it
// showed `browsing` before learning the sid is seated elsewhere).
function isStaleJoin(req: WsRequest | null, err: EngineErr): boolean {
  return req !== null && ("createTable" in req || "joinTable" in req) && "wrongPhase" in err;
}

// `#stale` on submit/leave/reset/claimWin: the stamped gen/turn moved on
// (typically a resend whose original landed).
function isStaleMutation(req: WsRequest | null, err: EngineErr): boolean {
  return (
    req !== null &&
    ("submit" in req || "leave" in req || "reset" in req || "claimWin" in req) &&
    "stale" in err
  );
}

export const CONNECTION_CLOSED_MESSAGE = "Connection closed.";

/// Shown when the first status after a reconnect finds a seated session
/// back in the lobby.
export const ENDED_WHILE_AWAY_MESSAGE = "Your game ended while you were away.";

export function createDuelClient<S = unknown, A = unknown>({
  ws,
  session,
  errorTtlMs = 5000,
}: ClientOptions<S>): DuelClient<S, A> {
  if (!ws) throw new Error("createDuelClient(): `ws` is required");
  if (!session) throw new Error("createDuelClient(): `session` is required");
  const sid = session.sid;

  let state: ClientState<S> = {
    connection: "connecting",
    status: null,
    statusAt: 0,
    pending: null,
    error: null,
    authPending: false,
    identityLocked: false,
  };
  const listeners = new Set<Listener<S>>();

  // An unrelated push landing mid-flight (a rival's join) still shows
  // `browsing` to this sid; that must not unlock identity while this
  // sid's own create/join is outstanding.
  const joinPending = (p: PendingCall | null): boolean =>
    p !== null && (p.key.startsWith("create:") || p.key.startsWith("jointable"));

  function setState(patch: Partial<ClientState<S>>): void {
    const next = { ...state, ...patch };
    next.identityLocked =
      next.connection === "closed" || next.authPending || joinPending(next.pending) || isSeated(next.status);
    let changed = false;
    for (const k of Object.keys(next) as (keyof ClientState<S>)[]) {
      if (next[k] !== state[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const prev = state;
    state = next;
    for (const l of [...listeners]) l(state, prev);
  }

  // Errors.

  let errorTimer: ReturnType<typeof setTimeout> | undefined;

  function clearErrorTimer(): void {
    if (errorTimer !== undefined) {
      clearTimeout(errorTimer);
      errorTimer = undefined;
    }
  }

  function showError(message: string): void {
    if (state.connection === "closed") return;
    clearErrorTimer();
    setState({ error: message });
    if (errorTtlMs > 0) {
      errorTimer = setTimeout(() => {
        errorTimer = undefined;
        setState({ error: null });
      }, errorTtlMs);
      (errorTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  function clearError(): void {
    if (state.connection === "closed") return;
    clearErrorTimer();
    setState({ error: null });
  }

  // Set for good once `ws.onclose` fires: the transport never revives.
  function closed(): void {
    if (state.connection === "closed") return;
    clearErrorTimer();
    setState({ connection: "closed", error: CONNECTION_CLOSED_MESSAGE, pending: null });
    settleFallback(null);
  }

  // Calls. One in flight at a time. With `request()` available the call
  // settles off its own reply; otherwise off the next `onmessage`, the
  // best a plain socket allows.

  const canCorrelate = typeof ws.request === "function";

  // The last dispatched request, so the `onmessage` error branch can tell
  // which request a pushed error answers.
  let lastReq: WsRequest | null = null;

  // The fallback transport's in-flight call, resolved by `onmessage`.
  let fallbackResolve: ((o: CallOutcome<S>) => void) | null = null;

  function settleFallback(outcome: CallOutcome<S> | null): void {
    const r = fallbackResolve;
    fallbackResolve = null;
    if (r) r(outcome ?? { ok: false, reason: "closed" });
  }

  // Set by `onconnecting` when the session was seated; the first status
  // after it decides whether to say the seat is gone.
  let seatedBeforeGap = false;

  function noteResync(status: Status<S>): void {
    if (!seatedBeforeGap) return;
    seatedBeforeGap = false;
    if (viewTagOf(status) === "browsing") showError(ENDED_WHILE_AWAY_MESSAGE);
  }

  function setStatus(status: Status<S>): void {
    if (deepEqual(status, state.status)) {
      noteResync(status);
      return;
    }
    setState({ status, statusAt: Date.now() });
    noteResync(status);
  }

  function sendWs(req: WsRequest): boolean {
    lastReq = req;
    try {
      ws.send({ req: { sid, req } });
      return true;
    } catch (e) {
      showError(`Send failed: ${(e as Error).message ?? e}`);
      return false;
    }
  }

  function refresh(): void {
    if (state.pending !== null) return;
    sendWs({ status: null });
  }

  function outcomeOf(req: WsRequest, payload: WsPayload<S>): CallOutcome<S> {
    if ("err" in payload) {
      if (isStaleJoin(req, payload.err) || isStaleMutation(req, payload.err)) {
        return { ok: false, reason: "stale" };
      }
      return { ok: false, reason: "rejected", err: payload.err, message: errText(payload.err) };
    }
    return { ok: true, view: payload.view };
  }

  function settleCall(req: WsRequest, payload: WsPayload<S>): CallOutcome<S> {
    const outcome = outcomeOf(req, payload);
    const isCurrent = state.pending !== null && state.pending.req === req;
    // One snapshot: a board drawn with the move applied locally goes
    // straight to the reply's, never back through the pre-move one.
    const patch: Partial<ClientState<S>> = isCurrent ? { pending: null } : {};
    if (outcome.ok && !deepEqual(outcome.view, state.status)) {
      Object.assign(patch, { status: outcome.view, statusAt: Date.now() });
    }
    setState(patch);
    if (outcome.ok) {
      noteResync(outcome.view);
      return outcome;
    }
    // A rejection usually means this tab's view is behind (the table is
    // gone, the seat was lost): the refresh replaces it with the truth.
    if (outcome.reason === "stale") {
      if (isCurrent) refresh();
    } else if (outcome.reason === "rejected") {
      if (isCurrent) {
        showError(outcome.message);
        refresh();
      }
    }
    return outcome;
  }

  function call(req: WsRequest): Promise<CallOutcome<S>> {
    if (state.connection === "closed") return Promise.resolve({ ok: false, reason: "closed" });
    if (state.pending !== null) return Promise.resolve({ ok: false, reason: "inFlight" });
    lastReq = req;
    setState({ pending: { key: pendingKeyOf(req), req } });
    if (canCorrelate) {
      const onRejected = (e: Error): CallOutcome<S> => {
        const message = `Call failed: ${e?.message ?? e}`;
        // Same guard as `settleCall`: a rejection for a superseded request
        // must not clear a newer call's pending state.
        if (state.pending !== null && state.pending.req === req) {
          setState({ pending: null });
          showError(message);
          refresh();
        }
        return { ok: false, reason: "failed", message };
      };
      // `request()` is caller-supplied, so guard a synchronous throw too.
      try {
        return ws.request!(sid, req).then((payload) => settleCall(req, payload), onRejected);
      } catch (e) {
        return Promise.resolve(onRejected(e as Error));
      }
    }
    return new Promise<CallOutcome<S>>((resolve) => {
      fallbackResolve = resolve;
      if (!sendWs(req)) {
        fallbackResolve = null;
        setState({ pending: null });
        resolve({ ok: false, reason: "failed", message: state.error ?? "Send failed" });
      }
    });
  }

  const seatOf = (seat: SeatTag): Seat => ({ [seat]: null }) as Seat;

  // Identity.

  async function identityAction(name: string, fn: (() => Promise<void>) | undefined): Promise<void> {
    if (!fn) return;
    if (state.authPending) return;
    setState({ authPending: true });
    try {
      await fn();
    } catch (e) {
      setState({ authPending: false });
      showError(`${name} failed: ${(e as Error)?.message ?? e}`);
    }
  }

  // Transport. The first status is requested right away, and again on
  // every relink after a gap.
  // `ws.queryStatus`, when offered, paints sooner still; whatever the
  // connection delivers supersedes it.

  let everOpened = false;
  ws.onopen = () => {
    const reopen = everOpened;
    everOpened = true;
    setState({ connection: "open" });
    if (reopen) refresh();
  };
  ws.onconnecting = () => {
    if (state.connection === "closed") return;
    seatedBeforeGap = isSeated(state.status);
    setState({ connection: everOpened ? "reconnecting" : "connecting" });
  };
  ws.onmessage = (ev) => {
    const msg = ev.data;
    const stale =
      "err" in msg && (isStaleJoin(lastReq, msg.err) || isStaleMutation(lastReq, msg.err));
    if (fallbackResolve !== null) {
      // The fallback transport's only settle signal.
      settleFallback(settleCall(lastReq!, msg));
      return;
    }
    if (stale) {
      // A correlating transport isn't guaranteed to deliver this to its
      // own `request()`; clear the spinner and resync here too. Two
      // refreshes are harmless — but only for the call `lastReq` still
      // names: a late reply to an already-superseded request must not
      // clear a newer call's `pending`.
      if (state.pending !== null && state.pending.req === lastReq) {
        setState({ pending: null });
      }
      refresh();
      return;
    }
    if ("err" in msg) showError(errText(msg.err));
    else setStatus(msg.view);
  };
  ws.onerror = (ev) => showError(`Connection error: ${ev?.error?.message ?? ev}`);
  ws.onclose = () => closed();
  refresh();
  if (typeof ws.queryStatus === "function") {
    try {
      ws.queryStatus(sid).then(
        (status) => {
          if (state.status === null && state.connection !== "closed") setStatus(status);
        },
        (e) => console.debug("[duel-client] status query failed:", (e as Error)?.message ?? e),
      );
    } catch (e) {
      console.debug("[duel-client] status query failed:", (e as Error)?.message ?? e);
    }
  }

  return {
    sid,
    session,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    createTable: (seat, visibility = { open: null }, variant = "") =>
      call({ createTable: { seat: seatOf(seat), visibility, variant } }),
    joinTable: (id, seat, code) =>
      call({ joinTable: { id, seat: seatOf(seat), code: code ? [code] : [] } }),
    submit: (move) => call({ submit: { gen: genOf(state.status), turn: turnOf(state.status), move } }),
    rematch: () => call({ rematch: null }),
    leave: () => call({ leave: { gen: genOf(state.status) } }),
    reset: () => call({ reset: { gen: genOf(state.status) } }),
    claimWin: () => call({ claimWin: { gen: genOf(state.status) } }),
    ackEnded: () => call({ ackEnded: null }),
    refresh,
    showError,
    clearError,
    login: () => identityAction("Log in", session.login),
    logout: () => identityAction("Log out", session.logout),
    regenerateSid: () => identityAction("New sid", session.regenerate),
    dispose() {
      clearErrorTimer();
      listeners.clear();
      if (ws.onopen) ws.onopen = null;
      if (ws.onmessage) ws.onmessage = null;
      if (ws.onerror) ws.onerror = null;
      if (ws.onclose) ws.onclose = null;
      if (ws.onconnecting) ws.onconnecting = null;
    },
  };
}
