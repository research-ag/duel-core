// The headless client: everything a duel-game-core game client does that
// is not drawing. It owns the `transport`, the current `Status`, the one call in
// flight, error lifetime, the session-identity lock, and the stale-view
// resync, and publishes an immutable `ClientState` snapshot to subscribers.
// No DOM, no storage, no HTML; `app.ts`'s `start()` is one UI over it and
// a game with its own screens binds this the same way. See ../README.md,
// "The headless client".

import type {
  Transport,
  DebriefView,
  EngineErr,
  GamePlugin,
  InGameView,
  Seat,
  SeatTag,
  StagingYouView,
  Status,
  View,
  Visibility,
  TransportPayload,
  TransportRequest,
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
      return "An anonymous identity can't play — reload the page.";
    case "tooManyTables":
      return `You are already at ${(v as { max: bigint }).max} tables — leave one first.`;
    case "badOptions":
      return v as string;
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

export function stepOf(status: Status | null): bigint {
  const inGame = viewOf<InGameView>(status, "inGame");
  return inGame ? inGame.step : 0n;
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
  req: TransportRequest;
}

/// The move a pending `submit` carries (the first of a `submitMoves`), or
/// null for any other call.
export function pendingMoveOf<A = unknown>(pending: PendingCall | null): A | null {
  const moves = pendingMovesOf<A>(pending);
  return moves.length > 0 ? moves[0] : null;
}

/// Every move a pending `submit`/`submitMoves` carries, in order; `[]` for
/// any other call.
export function pendingMovesOf<A = unknown>(pending: PendingCall | null): A[] {
  return pending === null ? [] : movesOf<A>(pending.req);
}

function movesOf<A>(req: TransportRequest): A[] {
  if ("submit" in req) return [req.submit.move as A];
  if ("submitMoves" in req) return req.submitMoves.moves as A[];
  return [];
}

/// `submit` for one move, `submitMoves` for several, so a host without
/// `duel_submit_moves` still takes single moves.
export function submitRequest<A>(gen: bigint, step: bigint, moves: readonly A[]): TransportRequest<A> {
  return moves.length === 1 ? { submit: { gen, step, move: moves[0] } } : { submitMoves: { gen, step, moves: [...moves] } };
}

function isSubmit(req: TransportRequest): boolean {
  return "submit" in req || "submitMoves" in req;
}

function submitStamp(req: TransportRequest): { gen: bigint; step: bigint } | null {
  if ("submit" in req) return req.submit;
  if ("submitMoves" in req) return req.submitMoves;
  return null;
}

// How many of a submit's moves the engine applied: the reply's step (a
// debrief's `steps`) less the step the call was stamped with. An
// opponent's answer inside the same reply (a canister bot) adds a step
// too, so this can count one dropped move as applied.
function appliedOf(req: TransportRequest, view: Status<unknown>): number {
  const stamp = submitStamp(req);
  const n = movesOf(req).length;
  if (stamp === null) return 0;
  const g = viewOf<InGameView>(view, "inGame");
  const d = viewOf<DebriefView>(view, "debrief");
  const after = g !== null && g.gen === stamp.gen ? g.step : d !== null && d.gen === stamp.gen ? d.steps : null;
  return after === null ? n : Math.max(0, Math.min(n, Number(after - stamp.step)));
}

export interface LocalMoveOptions<S, A = unknown> {
  /// Moves accepted behind the pending submit (`ClientState.queued`).
  queued?: readonly A[];
  /// `GamePlugin.localToMove`: with it, the seat stays on turn while the
  /// predicted board says so.
  localToMove?: (gameState: S) => SeatTag | null;
}

/// `status` as it will look once the pending submit (and any queued
/// follow-up moves) lands: the board through `applyLocal`, one move after
/// another while `localToMove` keeps the seat on turn, and the seat
/// flipped to waiting unless it still does. Unchanged when nothing is
/// pending, `applyLocal` returns null for the first move, or `status`
/// already moved past the view the move was stamped against (gen/step
/// changed, or the move is already in). Without `localToMove` only the
/// first move is shown (the client cannot tell when the turn passes), and
/// a `turnBased` seat is shown as waiting until the reply says whose turn
/// it is — the rules may keep the mover on turn. Display only — calls
/// keep reading the real status; `ClientState.predicted` holds the
/// client's own result.
/// See ../README.md, "Showing moves" and "Follow-up moves".
export function withLocalMove<S, A = unknown>(
  status: Status<S> | null,
  pending: PendingCall | null,
  applyLocal: ((gameState: S, mySeat: SeatTag, move: A) => S | null) | undefined,
  { queued = [], localToMove }: LocalMoveOptions<S, A> = {},
): Status<S> | null {
  const stamp = pending === null ? null : submitStamp(pending.req);
  if (!applyLocal || stamp === null) return status;
  const at = atTableOf(status);
  const v = viewOf<InGameView<S>>(status, "inGame");
  if (at === null || v === null || v.youSubmitted) return status;
  if (v.gen !== stamp.gen || v.step !== stamp.step) return status;
  const turnBased = "turnBased" in v.mode;
  const seat = tag(v.seat) as SeatTag;
  const moves = turnBased ? [...pendingMovesOf<A>(pending), ...queued] : pendingMovesOf<A>(pending).slice(0, 1);
  let game = v.game;
  let applied = 0;
  for (const move of moves) {
    if (applied > 0 && (!localToMove || localToMove(game) !== seat)) break;
    const next = applyLocal(game, seat, move);
    if (next === null) break;
    game = next;
    applied++;
  }
  if (applied === 0) return status;
  const step = turnBased ? v.step + BigInt(applied) : v.step;
  const local: InGameView<S> =
    turnBased && localToMove?.(game) === seat
      ? { ...v, game, step }
      : {
          ...v,
          game,
          step,
          toMove: turnBased ? [] : v.toMove,
          youSubmitted: true,
          oppSubmitted: turnBased ? false : v.oppSubmitted,
          claimWinAvailable: false,
          secondsUntilClaimable: v.claimTimeoutSecs,
        };
  return { atTable: { id: at.id, view: { inGame: local } } };
}

export interface ClientState<S = unknown> {
  connection: Connection;
  /// The last status received (the first may come from `transport.queryStatus`
  /// while still `"connecting"`); `null` until one lands.
  status: Status<S> | null;
  /// `Date.now()` when `status` last changed. Every `secondsUntilX` field
  /// is only as fresh as that moment; see `localSecondsLeft`.
  statusAt: number;
  pending: PendingCall | null;
  /// Follow-up moves accepted behind the pending submit, sent as one call
  /// once its reply lands (or dropped when the turn has passed by then).
  queued: readonly unknown[];
  /// `status` as a screen draws it: with the pending submit and `queued`
  /// applied through the `plugin`'s `applyLocal` (`withLocalMove`), or
  /// `status` itself when nothing is overlaid. Recomputed only when
  /// `status`, `pending` or `queued` changes, so it stays `===` across
  /// any other change.
  predicted: Status<S> | null;
  /// A `submit` now would be queued behind the pending one: the predicted
  /// board still has this seat on turn. Needs a `plugin` with both
  /// `applyLocal` and `localToMove`; a UI keeps its move controls live.
  followUp: boolean;
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
  /// A follow-up move that was not applied: the reply it waited on made it
  /// moot (the turn passed, or that call failed) so it was never sent, or
  /// the engine dropped it from its batch.
  | { ok: false; reason: "dropped" }
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

  createTable(seat: SeatTag, visibility?: Visibility, options?: unknown): Promise<CallOutcome<S>>;
  joinTable(id: bigint, seat: SeatTag, code?: string | null): Promise<CallOutcome<S>>;
  /// While `state.followUp`, the move is queued instead (`inFlight` when
  /// `applyLocal` rejects it on the predicted board) and resolves with its
  /// batch's outcome, or `dropped` when the engine did not apply it.
  submit(move: A): Promise<CallOutcome<S>>;
  /// Several actions of one turn in one call, planned by the caller; the
  /// engine applies them in order and drops the rest at the first that
  /// fails or once the turn passes.
  submitMoves(moves: A[]): Promise<CallOutcome<S>>;
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

  /// Detaches from `transport` and stops the error timer.
  dispose(): void;
}

export interface ClientOptions<S = unknown> {
  transport: Transport<S>;
  session: SessionIdentity;
  /// How long a transient error stays in `state.error`; default 5000, 0
  /// keeps it until `clearError()` or the next error.
  errorTtlMs?: number;
  /// The game's local rules (a `GamePlugin` will do): with both hooks,
  /// follow-up moves queue behind an in-flight submit.
  plugin?: Pick<GamePlugin<S>, "applyLocal" | "localToMove">;
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
export function pendingKeyOf(req: TransportRequest): string {
  if ("createTable" in req) return `create:${tag(req.createTable.seat)}`;
  if ("joinTable" in req) return `jointable:${req.joinTable.id}:${tag(req.joinTable.seat)}`;
  if ("submit" in req) return `act:${safeJson(req.submit.move)}`;
  if ("submitMoves" in req) return `act:${safeJson(req.submitMoves.moves[0])}`;
  if ("rematch" in req) return "rematch";
  if ("leave" in req) return "leave";
  if ("reset" in req) return "reset";
  if ("claimWin" in req) return "claim-win";
  if ("ackEnded" in req) return "ack";
  return "";
}

// A `#wrongPhase` on create/join means this tab's view is stale (it
// showed `browsing` before learning the sid is seated elsewhere).
function isStaleJoin(req: TransportRequest | null, err: EngineErr): boolean {
  return req !== null && ("createTable" in req || "joinTable" in req) && "wrongPhase" in err;
}

// `#stale` on a submit/leave/reset/claimWin: the stamped gen/step moved on
// (typically a resend whose original landed).
function isStaleMutation(req: TransportRequest | null, err: EngineErr): boolean {
  return (
    req !== null && (isSubmit(req) || "leave" in req || "reset" in req || "claimWin" in req) && "stale" in err
  );
}

export const CONNECTION_CLOSED_MESSAGE = "Connection closed.";

/// Shown when the first status after a reconnect finds a seated session
/// back in the lobby.
export const ENDED_WHILE_AWAY_MESSAGE = "Your game ended while you were away.";

export function createDuelClient<S = unknown, A = unknown>({
  transport,
  session,
  errorTtlMs = 5000,
  plugin,
}: ClientOptions<S>): DuelClient<S, A> {
  if (!transport) throw new Error("createDuelClient(): `transport` is required");
  if (!session) throw new Error("createDuelClient(): `session` is required");
  const sid = session.sid;

  let state: ClientState<S> = {
    connection: "connecting",
    status: null,
    statusAt: 0,
    pending: null,
    queued: [],
    predicted: null,
    followUp: false,
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

  const applyLocal = plugin?.applyLocal?.bind(plugin);
  const localToMove = plugin?.localToMove?.bind(plugin);

  function canFollowUp(s: ClientState<S>): boolean {
    if (!canCorrelate || !applyLocal || !localToMove || s.pending === null || !isSubmit(s.pending.req)) return false;
    if (s.connection === "closed") return false;
    const v = viewOf<InGameView<S>>(s.predicted, "inGame");
    return v !== null && "turnBased" in v.mode && !v.youSubmitted && localToMove(v.game) === tag(v.seat);
  }

  function setState(patch: Partial<ClientState<S>>): void {
    const next = { ...state, ...patch };
    if (next.status !== state.status || next.pending !== state.pending || next.queued !== state.queued) {
      next.predicted = withLocalMove(next.status, next.pending, applyLocal, { queued: next.queued, localToMove });
    }
    next.identityLocked =
      next.connection === "closed" || next.authPending || joinPending(next.pending) || isSeated(next.status);
    next.followUp = canFollowUp(next);
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

  // Set for good once `transport.onclose` fires: the transport never revives.
  function closed(): void {
    if (state.connection === "closed") return;
    clearErrorTimer();
    setState({ connection: "closed", error: CONNECTION_CLOSED_MESSAGE, pending: null, ...dropQueue() });
    settleFallback(null);
  }

  // Calls. One in flight at a time. With `request()` available the call
  // settles off its own reply; otherwise off the next `onmessage`, the
  // best a plain socket allows.

  const canCorrelate = typeof transport.request === "function";

  // Follow-up moves. Each queued `submit` waits on the batch it goes out
  // in; see ../README.md, "Follow-up moves".
  let queueWaiters: ((o: CallOutcome<S>) => void)[] = [];

  function takeWaiters(): ((o: CallOutcome<S>) => void)[] {
    const w = queueWaiters;
    queueWaiters = [];
    return w;
  }

  // The patch that empties the queue; its moves resolve as `dropped`.
  function dropQueue(): Partial<ClientState<S>> {
    for (const w of takeWaiters()) w({ ok: false, reason: "dropped" });
    return state.queued.length > 0 ? { queued: [] } : {};
  }

  // The last dispatched request, so the `onmessage` error branch can tell
  // which request a pushed error answers.
  let lastReq: TransportRequest | null = null;

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

  function sendTransport(req: TransportRequest): boolean {
    lastReq = req;
    try {
      transport.send({ req: { sid, req } });
      return true;
    } catch (e) {
      showError(`Send failed: ${(e as Error).message ?? e}`);
      return false;
    }
  }

  function refresh(): void {
    if (state.pending !== null) return;
    sendTransport({ status: null });
  }

  function outcomeOf(req: TransportRequest, payload: TransportPayload<S>): CallOutcome<S> {
    if ("err" in payload) {
      if (isStaleJoin(req, payload.err) || isStaleMutation(req, payload.err)) {
        return { ok: false, reason: "stale" };
      }
      return { ok: false, reason: "rejected", err: payload.err, message: errText(payload.err) };
    }
    return { ok: true, view: payload.view };
  }

  function settleCall(req: TransportRequest, payload: TransportPayload<S>): CallOutcome<S> {
    const outcome = outcomeOf(req, payload);
    const isCurrent = state.pending !== null && state.pending.req === req;
    // One snapshot: a board drawn with the move applied locally goes
    // straight to the reply's, never back through the pre-move one — and
    // with a queue, straight into the next batch.
    const patch: Partial<ClientState<S>> = isCurrent ? { pending: null } : {};
    if (outcome.ok && !deepEqual(outcome.view, state.status)) {
      Object.assign(patch, { status: outcome.view, statusAt: Date.now() });
    }
    // The queue goes out only if every move of `req` applied and the seat
    // is still on turn: an opponent's step in between voids the plan.
    let batch: TransportRequest | null = null;
    if (isCurrent && state.queued.length > 0) {
      const v = outcome.ok ? viewOf<InGameView<S>>(outcome.view, "inGame") : null;
      const stamp = submitStamp(req);
      if (
        v !== null &&
        stamp !== null &&
        !v.youSubmitted &&
        v.gen === stamp.gen &&
        v.step === stamp.step + BigInt(movesOf(req).length)
      ) {
        batch = submitRequest(v.gen, v.step, state.queued);
        Object.assign(patch, { pending: { key: pendingKeyOf(batch), req: batch }, queued: [] });
      } else Object.assign(patch, dropQueue());
    }
    setState(patch);
    if (batch !== null) {
      const sent = batch;
      const waiters = takeWaiters();
      void send(sent).then((o) => {
        // Each queued move gets its own outcome: the ones the engine
        // applied share the reply, the rest were dropped. A rejection
        // answers the first; anything else (failed, stale) answers all.
        const kept = o.ok ? appliedOf(sent, o.view) : o.reason === "rejected" ? 1 : waiters.length;
        waiters.forEach((w, i) => w(i < kept ? o : { ok: false, reason: "dropped" }));
      });
    }
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

  function call(req: TransportRequest): Promise<CallOutcome<S>> {
    if (state.connection === "closed") return Promise.resolve({ ok: false, reason: "closed" });
    if (state.pending !== null) return Promise.resolve({ ok: false, reason: "inFlight" });
    setState({ pending: { key: pendingKeyOf(req), req } });
    return send(req);
  }

  // Sends `req`, already set as `state.pending`.
  function send(req: TransportRequest): Promise<CallOutcome<S>> {
    lastReq = req;
    if (canCorrelate) {
      const onRejected = (e: Error): CallOutcome<S> => {
        const message = `Call failed: ${e?.message ?? e}`;
        // Same guard as `settleCall`: a rejection for a superseded request
        // must not clear a newer call's pending state.
        if (state.pending !== null && state.pending.req === req) {
          setState({ pending: null, ...dropQueue() });
          showError(message);
          refresh();
        }
        return { ok: false, reason: "failed", message };
      };
      // `request()` is caller-supplied, so guard a synchronous throw too.
      try {
        return transport.request!(sid, req).then((payload) => settleCall(req, payload), onRejected);
      } catch (e) {
        return Promise.resolve(onRejected(e as Error));
      }
    }
    return new Promise<CallOutcome<S>>((resolve) => {
      fallbackResolve = resolve;
      if (!sendTransport(req)) {
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
  // `transport.queryStatus`, when offered, paints sooner still; whatever the
  // connection delivers supersedes it.

  let everOpened = false;
  transport.onopen = () => {
    const reopen = everOpened;
    everOpened = true;
    setState({ connection: "open" });
    if (reopen) refresh();
  };
  transport.onconnecting = () => {
    if (state.connection === "closed") return;
    seatedBeforeGap = isSeated(state.status);
    setState({ connection: everOpened ? "reconnecting" : "connecting" });
  };
  transport.onmessage = (ev) => {
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
        setState({ pending: null, ...dropQueue() });
      }
      refresh();
      return;
    }
    if ("err" in msg) showError(errText(msg.err));
    else setStatus(msg.view);
  };
  transport.onerror = (ev) => showError(`Connection error: ${ev?.error?.message ?? ev}`);
  transport.onclose = () => closed();
  refresh();
  if (typeof transport.queryStatus === "function") {
    try {
      transport.queryStatus(sid).then(
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
    createTable: (seat, visibility = { open: null }, options = {}) =>
      call({ createTable: { seat: seatOf(seat), visibility, options } }),
    joinTable: (id, seat, code) =>
      call({ joinTable: { id, seat: seatOf(seat), code: code ? [code] : [] } }),
    submit(move) {
      if (state.pending === null || !state.followUp) return call(submitRequest(genOf(state.status), stepOf(state.status), [move]));
      const v = viewOf<InGameView<S>>(state.predicted, "inGame");
      if (v === null || applyLocal!(v.game, tag(v.seat) as SeatTag, move) === null) {
        return Promise.resolve({ ok: false, reason: "inFlight" });
      }
      setState({ queued: [...state.queued, move] });
      return new Promise<CallOutcome<S>>((resolve) => queueWaiters.push(resolve));
    },
    submitMoves: (moves) =>
      moves.length === 0
        ? Promise.resolve({ ok: false, reason: "inFlight" })
        : call(submitRequest(genOf(state.status), stepOf(state.status), moves)),
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
      dropQueue();
      listeners.clear();
      if (transport.onopen) transport.onopen = null;
      if (transport.onmessage) transport.onmessage = null;
      if (transport.onerror) transport.onerror = null;
      if (transport.onclose) transport.onclose = null;
      if (transport.onconnecting) transport.onconnecting = null;
    },
  };
}
