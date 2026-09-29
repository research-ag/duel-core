// Generic bootstrap for any duel-game-core game client: session identity,
// real-time push over a caller-built `ws`, the generic screens (render.ts),
// and click dispatch back to the canister. There is exactly one
// transport and no polling fallback; `start()` never calls a plain actor
// method. `ws` must expose `onopen`/`onmessage`/`onclose`/`onerror` and
// `send(msg)`; if it also exposes `request(sid, req)` (`GatewayWs` does),
// each button's spinner settles off that call's own reply instead of the
// shared push stream. See ../README.md, "Wiring it up".

import {
  renderStatus,
  errText,
  tag,
  val,
  DUEL_IDLE_WARNING_ID,
  idleWarningThreshold,
  idleWarningText,
  DUEL_RECLAIM_WARNING_ID,
  RECLAIM_WARNING_SECS,
  reclaimWarningText,
  DUEL_CLAIM_WARNING_ID,
  DUEL_CLAIM_BUTTON_ID,
  claimWarningText,
  atRiskWarningText,
  claimWarningThreshold,
  waitingText,
} from "./render.js";
import type { DuelWs, EngineErr, GamePlugin, InGameView, Seat, SeatTag, StagingYouView, Visibility, WsPayload, WsRequest } from "./types.js";

const $ = (id: string): HTMLElement | null => document.getElementById(id);

/// Structural equality for decoded Candid values. Not `JSON.stringify`:
/// `bigint` fields would throw.
function deepEqual(a: unknown, b: unknown): boolean {
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

/// A once-per-second local countdown for a warning element. `secondsUntilX`
/// fields are only as fresh as the last push (nothing pushes on a bare
/// tick), so this patches `hidden`/`textContent` in place without touching
/// `screenEl.innerHTML` (which would reintroduce hover flicker).
function makeCountdownTicker(elId: string) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let baseline: {
    secs: bigint;
    atMs: number;
    hidden: (secondsLeft: bigint) => boolean;
    text: (secondsLeft: bigint) => string;
  } | undefined;

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    baseline = undefined;
  }

  function tick(): void {
    if (!baseline) return;
    if (typeof document === "undefined") return; // a Node test tore its mock down
    const el = document.getElementById(elId);
    if (!el) return;
    const elapsed = BigInt(Math.max(0, Math.floor((Date.now() - baseline.atMs) / 1000)));
    const remaining = baseline.secs > elapsed ? baseline.secs - elapsed : 0n;
    el.hidden = baseline.hidden(remaining);
    el.textContent = baseline.text(remaining);
  }

  function sync(
    next: { secs: bigint; hidden: (secondsLeft: bigint) => boolean; text: (secondsLeft: bigint) => string } | null,
  ): void {
    if (next === null) {
      stop();
      return;
    }
    baseline = { secs: next.secs, atMs: Date.now(), hidden: next.hidden, text: next.text };
    if (timer === undefined) {
      timer = setInterval(tick, 1000);
      // Don't keep a Node process alive; a no-op in browsers.
      (timer as unknown as { unref?: () => void }).unref?.();
    }
    tick();
  }

  return { sync };
}

/// Like `makeCountdownTicker`, but only toggles `hidden` — safe for an
/// element with child markup (the "Claim the win" button). Revealing it a
/// moment early off the local clock is harmless: the engine re-validates.
function makeVisibilityTicker(elId: string) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let baseline: { secs: bigint; atMs: number } | undefined;

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    baseline = undefined;
  }

  function tick(): void {
    if (!baseline) return;
    if (typeof document === "undefined") return;
    const el = document.getElementById(elId);
    if (!el) return;
    const elapsed = BigInt(Math.max(0, Math.floor((Date.now() - baseline.atMs) / 1000)));
    const remaining = baseline.secs > elapsed ? baseline.secs - elapsed : 0n;
    el.hidden = remaining > 0n;
  }

  function sync(next: { secs: bigint } | null): void {
    if (next === null) {
      stop();
      return;
    }
    baseline = { secs: next.secs, atMs: Date.now() };
    if (timer === undefined) {
      timer = setInterval(tick, 1000);
      (timer as unknown as { unref?: () => void }).unref?.();
    }
    tick();
  }

  return { sync };
}

/// Counts every "waiting Ns" table-row label UP from its pushed baseline.
/// `sync()` re-scans `root` after each redraw, since a redraw recreates
/// the row elements.
function makeTableWaitTicker(root: HTMLElement) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let rows: { el: HTMLElement; baseSecs: bigint; atMs: number }[] = [];

  function tick(): void {
    for (const row of rows) {
      const elapsed = BigInt(Math.max(0, Math.floor((Date.now() - row.atMs) / 1000)));
      row.el.textContent = waitingText(row.baseSecs + elapsed);
    }
  }

  function sync(): void {
    rows = [...root.querySelectorAll<HTMLElement>("[data-wait-base]")].map((el) => ({
      el,
      baseSecs: BigInt(el.dataset.waitBase ?? "0"),
      atMs: Date.now(),
    }));
    if (rows.length === 0) {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      return;
    }
    tick();
    if (timer === undefined) {
      timer = setInterval(tick, 1000);
      (timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  return { sync };
}

/// The minimal identity `start()` needs — `identity.js`'s `ResolvedIdentity`
/// and `anon-identity.js`'s lighter result both satisfy it.
export interface SessionIdentity {
  sid: string;
  isLoggedIn?: boolean;
  /// The "new sid" button is hidden entirely when this is missing.
  regenerate?(): Promise<void>;
  /// Wired to `authBtnId` only when BOTH are present.
  login?(): Promise<void>;
  logout?(): Promise<void>;
}

export interface StartOptions<S = unknown> {
  plugin: GamePlugin<S>;
  ws: DuelWs<S>;
  sidElId?: string;
  newSidBtnId?: string;
  screenElId?: string;
  errorElId?: string;
  /// Required: every legal `sid` is principal-bound.
  session: SessionIdentity;
  authBtnId?: string;
}

/// Boots the generic wiring. Defaults: `sid`, `new-sid`, `screen`, `error`,
/// `duel-auth-btn`.
export function start<S>({
  plugin,
  ws,
  sidElId = "sid",
  newSidBtnId = "new-sid",
  screenElId = "screen",
  errorElId = "error",
  session,
  authBtnId = "duel-auth-btn",
}: StartOptions<S>): void {
  if (!plugin) throw new Error("start(): `plugin` is required");
  if (!ws) throw new Error("start(): `ws` is required");
  if (!session) throw new Error("start(): `session` is required");

  // Declared up front so every closure below sees it as non-null (TS
  // can't carry a narrowing into a hoisted function declaration).
  const screenEl = $(screenElId);
  if (!screenEl) throw new Error(`start(): no element with id "${screenElId}"`);

  // Session identity. `sessionStorage["sid"]` is where game code outside
  // `start()` (a second bundle sharing the connection) reads the sid.
  sessionStorage.setItem("sid", session.sid);
  const sid = session.sid;
  const sidEl = $(sidElId);
  if (sidEl) sidEl.textContent = sid;
  const newSidBtn = $(newSidBtnId) as HTMLButtonElement | null;
  if (newSidBtn) {
    if (!session.regenerate || session.isLoggedIn) {
      newSidBtn.disabled = true;
      newSidBtn.hidden = true;
    } else {
      const regenerate = session.regenerate;
      newSidBtn.addEventListener("click", () => {
        if (newSidBtn.disabled) return;
        newSidBtn.disabled = true;
        regenerate().catch((e: Error) => {
          newSidBtn.disabled = false;
          showError(`New sid failed: ${e?.message ?? e}`);
        });
      });
    }
  }

  // Login/logout. Static for the page's life: both always reload.
  const authBtn = $(authBtnId) as HTMLButtonElement | null;
  // Keeps an unrelated re-sync from re-enabling the button mid-action.
  let authActionPending = false;
  if (authBtn && session.login && session.logout) {
    const login = session.login;
    const logout = session.logout;
    authBtn.textContent = session.isLoggedIn ? "Log out" : "Log in with Internet Identity";
    authBtn.disabled = false;
    authBtn.addEventListener("click", () => {
      if (authBtn.disabled) return;
      authActionPending = true;
      authBtn.disabled = true;
      const verb = session.isLoggedIn ? "Log out" : "Log in";
      (session.isLoggedIn ? logout() : login()).catch((e: Error) => {
        authActionPending = false;
        authBtn.disabled = newSidBtn?.disabled ?? false;
        showError(`${verb} failed: ${e?.message ?? e}`);
      });
    });
  }

  // Swapping identity mid-seat/mid-join is as unsafe for login/logout as
  // for regenerating the sid, so both buttons follow the same state.
  function setNewSidDisabled(disabled: boolean): void {
    if (newSidBtn) newSidBtn.disabled = disabled;
    if (authBtn && session.login && session.logout && !authActionPending) authBtn.disabled = disabled;
  }

  // Swapping sid while holding one of these seats would abandon it.
  const SEATED_VIEW_TAGS = new Set(["stagingYou", "inGame", "debrief"]);

  function atTable(status: unknown): { id: bigint; view: unknown } | null {
    if (status == null) return null;
    if (tag(status as object) !== "atTable") return null;
    return val(status as object) as { id: bigint; view: unknown };
  }

  function isSeated(status: unknown): boolean {
    const at = atTable(status);
    return at !== null && SEATED_VIEW_TAGS.has(tag(at.view as object));
  }

  function inGameView(status: unknown): InGameView | null {
    const at = atTable(status);
    if (at === null || tag(at.view as object) !== "inGame") return null;
    return val(at.view as object) as InGameView;
  }

  function stagingYouView(status: unknown): StagingYouView | null {
    const at = atTable(status);
    if (at === null || tag(at.view as object) !== "stagingYou") return null;
    return val(at.view as object) as StagingYouView;
  }

  // An unrelated push landing mid-flight (a rival's join) still shows
  // `browsing` to this sid; that must not re-enable new-sid while this
  // sid's own create/join is outstanding.
  const joinPending = (): boolean =>
    pendingButtonKey !== null &&
    (pendingButtonKey.startsWith("create:") || pendingButtonKey.startsWith("jointable"));

  const syncNewSidBtn = (): void => {
    if (!newSidBtn) return;
    if (joinPending()) {
      setNewSidDisabled(true);
      return;
    }
    if (lastStatus === undefined) return;
    setNewSidDisabled(isSeated(lastStatus));
  };

  // Errors.

  let errorTimer: ReturnType<typeof setTimeout>;

  // Set for good once `ws.onclose` fires: the transport never revives, so
  // the persistent banner wins and every button stays disabled.
  let disconnected = false;

  function showError(msg: string): void {
    if (disconnected) return;
    const el = $(errorElId);
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => (el.hidden = true), 5000);
  }

  function showDisconnected(): void {
    if (disconnected) return;
    disconnected = true;
    clearTimeout(errorTimer);
    const el = $(errorElId);
    if (el) {
      el.innerHTML = `Connection closed. <button type="button" class="ghost" id="duel-reload">Reload to reconnect</button>`;
      el.hidden = false;
      $("duel-reload")?.addEventListener("click", () => location.reload());
    }
    setNewSidDisabled(true);
    applyLoadingState();
  }

  // Calls. `inFlight` stops a double submit. With `request()` available,
  // the spinner settles off THIS call's reply; otherwise off the next
  // `onmessage`, the best a plain socket allows.

  let inFlight = false;
  const canCorrelate = typeof ws.request === "function";

  // The last dispatched request, so the fallback `onmessage` error branch
  // can tell which request a pushed error answers.
  let lastReq: WsRequest | null = null;

  // A `#wrongPhase` on create/join means this tab's view is stale (it
  // rendered `browsing` before learning the sid is seated elsewhere); a
  // silent refresh resolves it.
  function isStaleJoin(req: WsRequest | null, err: EngineErr): boolean {
    return req !== null && ("createTable" in req || "joinTable" in req) && "wrongPhase" in err;
  }

  // `#stale` on submit/leave/reset/claimWin: the stamped gen/turn moved on
  // (typically a resend whose original landed). Same treatment.
  function isStaleMutation(req: WsRequest | null, err: EngineErr): boolean {
    return (
      req !== null &&
      ("submit" in req || "leave" in req || "reset" in req || "claimWin" in req) &&
      "stale" in err
    );
  }

  // `0n` outside a live phase; the engine rejects it as `#stale`.
  function genOf(status: unknown): bigint {
    const at = atTable(status);
    if (!at) return 0n;
    const t = tag(at.view as object);
    if (t === "stagingYou" || t === "inGame" || t === "debrief" || t === "awaitingRematch") {
      return (val(at.view as object) as { gen: bigint }).gen;
    }
    return 0n;
  }
  function turnOf(status: unknown): bigint {
    const at = atTable(status);
    if (at && tag(at.view as object) === "inGame") {
      return (val(at.view as object) as { turn: bigint }).turn;
    }
    return 0n;
  }

  function sendWs(req: WsRequest): void {
    lastReq = req;
    try {
      ws.send({ req: { sid, req } });
    } catch (e) {
      inFlight = false;
      document.body.classList.remove("working");
      endButtonLoading();
      showError(`Send failed: ${(e as Error).message ?? e}`);
    }
  }

  function settleCall(req: WsRequest, payload: WsPayload<S>): void {
    inFlight = false;
    document.body.classList.remove("working");
    endButtonLoading();
    if ("err" in payload) {
      if (isStaleJoin(req, payload.err) || isStaleMutation(req, payload.err)) {
        // `ws.onmessage` runs the same check; a transport implementing
        // `request()` isn't guaranteed to also deliver this there. Two
        // refreshes are harmless.
        refresh();
        return;
      }
      showError(errText(payload.err));
      // Undo the eager disable a create/join applied speculatively.
      syncNewSidBtn();
    } else {
      renderIfChanged(payload.view);
    }
  }

  function call(req: WsRequest): void {
    if (inFlight) return;
    inFlight = true;
    lastReq = req;
    document.body.classList.add("working");
    if (canCorrelate) {
      // `request()` is caller-supplied, so guard a synchronous throw too.
      const onRejected = (e: Error) => {
        inFlight = false;
        document.body.classList.remove("working");
        endButtonLoading();
        showError(`Call failed: ${e.message ?? e}`);
      };
      try {
        ws.request!(sid, req).then((payload) => settleCall(req, payload), onRejected);
      } catch (e) {
        onRejected(e as Error);
      }
    } else {
      sendWs(req);
    }
  }

  const doCreateTable = (seat: SeatTag, visibility: Visibility, variant: string) =>
    call({ createTable: { seat: { [seat]: null } as Seat, visibility, variant } });
  const doJoinTable = (id: bigint, seat: SeatTag, code: [] | [string]) =>
    call({ joinTable: { id, seat: { [seat]: null } as Seat, code } });
  const doSubmit = (action: unknown) =>
    call({ submit: { gen: genOf(lastStatus), turn: turnOf(lastStatus), move: action } });
  const doRematch = () => call({ rematch: null });
  const doLeave = () => call({ leave: { gen: genOf(lastStatus) } });
  const doReset = () => call({ reset: { gen: genOf(lastStatus) } });
  const doClaimWin = () => call({ claimWin: { gen: genOf(lastStatus) } });
  const doAck = () => call({ ackEnded: null });

  // Per-button loading spinner (`button.duel-loading`). The pending action
  // is tracked by a content key (what the button does), not the node, and
  // reapplied after EVERY render — an unrelated push mid-flight replaces
  // `screenEl.innerHTML` and would otherwise lose the spinner while the
  // call is still outstanding.

  function buttonKey(b: HTMLButtonElement): string {
    if (b.dataset.createTable) return `create:${b.dataset.createTable}`;
    if (b.dataset.joinTable && b.dataset.joinTableId) {
      return `jointable:${b.dataset.joinTableId}:${b.dataset.joinTable}`;
    }
    if (b.dataset.act) return `act:${b.dataset.act}`;
    if ("rematch" in b.dataset) return "rematch";
    if ("leave" in b.dataset) return "leave";
    if ("reset" in b.dataset) return "reset";
    if ("claimWin" in b.dataset) return "claim-win";
    if ("ack" in b.dataset) return "ack";
    return "";
  }

  let pendingButtonKey: string | null = null;

  // Each button's server-driven disabled state is stashed in
  // `dataset.naturalDisabled` on first sight so it can be restored.
  const applyLoadingState = (): void => {
    for (const btn of screenEl.querySelectorAll("button")) {
      const el = btn as HTMLButtonElement;
      if (el.dataset.naturalDisabled === undefined) {
        el.dataset.naturalDisabled = el.disabled ? "1" : "0";
      }
      if (disconnected) {
        el.disabled = true;
        el.classList.remove("duel-loading");
      } else if (pendingButtonKey) {
        el.disabled = true;
        el.classList.toggle("duel-loading", buttonKey(el) === pendingButtonKey);
      } else {
        el.disabled = el.dataset.naturalDisabled === "1";
        el.classList.remove("duel-loading");
      }
    }
  };

  // Arrow consts, not function declarations, so `screenEl`'s narrowing
  // carries in. `directBtn` is marked directly as well as via
  // `applyLoadingState()`: a minimal test DOM has no querySelectorAll.
  let directBtn: HTMLButtonElement | null = null;

  const beginButtonLoading = (activeBtn: HTMLButtonElement): void => {
    pendingButtonKey = buttonKey(activeBtn);
    directBtn = activeBtn;
    if (activeBtn.dataset.naturalDisabled === undefined) {
      activeBtn.dataset.naturalDisabled = activeBtn.disabled ? "1" : "0";
    }
    activeBtn.disabled = true;
    activeBtn.classList.add("duel-loading");
    applyLoadingState();
  };

  const endButtonLoading = (): void => {
    pendingButtonKey = null;
    if (directBtn?.isConnected) {
      directBtn.disabled = directBtn.dataset.naturalDisabled === "1";
      directBtn.classList.remove("duel-loading");
    }
    directBtn = null;
    applyLoadingState();
  };

  // Confirmation modal for `data-confirm="..."` buttons. Appended to
  // `<body>`, not `screenEl`, so it survives redraws and a game's
  // click-through overlay CSS.

  const confirmOverlay = document.createElement("div");
  confirmOverlay.className = "duel-confirm-overlay";
  confirmOverlay.hidden = true;
  confirmOverlay.innerHTML = `
    <div class="duel-confirm-box">
      <p class="duel-confirm-msg"></p>
      <div class="duel-confirm-actions">
        <button type="button" class="ghost" data-confirm-no>Cancel</button>
        <button type="button" class="primary" data-confirm-yes>Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(confirmOverlay);
  const confirmMsgEl = confirmOverlay.querySelector(".duel-confirm-msg") as HTMLElement;

  let pendingConfirmed: (() => void) | null = null;

  function showConfirm(msg: string, onConfirmed: () => void): void {
    confirmMsgEl.textContent = msg;
    pendingConfirmed = onConfirmed;
    confirmOverlay.hidden = false;
  }

  function hideConfirm(): void {
    confirmOverlay.hidden = true;
    pendingConfirmed = null;
  }

  confirmOverlay.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (target === confirmOverlay || "confirmNo" in target.dataset) {
      hideConfirm();
    } else if ("confirmYes" in target.dataset) {
      const fn = pendingConfirmed;
      hideConfirm();
      if (fn) fn();
    }
  });

  // Access-code prompt for an open seat on a protected table row
  // (`data-protected`). Same build-once-append-to-body shape.

  const codeOverlay = document.createElement("div");
  codeOverlay.className = "duel-code-overlay";
  codeOverlay.hidden = true;
  codeOverlay.innerHTML = `
    <div class="duel-code-box">
      <p class="duel-code-msg">This table is protected — enter its access code to join.</p>
      <input type="text" class="duel-code-input" placeholder="access code" />
      <div class="duel-code-actions">
        <button type="button" class="ghost" data-code-cancel>Cancel</button>
        <button type="button" class="primary" data-code-join>Join</button>
      </div>
    </div>`;
  document.body.appendChild(codeOverlay);
  const codeInputEl = codeOverlay.querySelector(".duel-code-input") as HTMLInputElement;

  let pendingCodeSubmit: ((code: string) => void) | null = null;

  function showCodePrompt(onSubmit: (code: string) => void): void {
    codeInputEl.value = "";
    pendingCodeSubmit = onSubmit;
    codeOverlay.hidden = false;
    codeInputEl.focus?.();
  }

  function hideCodePrompt(): void {
    codeOverlay.hidden = true;
    pendingCodeSubmit = null;
  }

  codeOverlay.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (target === codeOverlay || "codeCancel" in target.dataset) {
      hideCodePrompt();
    } else if ("codeJoin" in target.dataset) {
      const fn = pendingCodeSubmit;
      const code = codeInputEl.value;
      hideCodePrompt();
      if (fn) fn(code);
    }
  });

  // Create-table form: the visibility radio toggles the code input.
  screenEl.addEventListener("change", (ev) => {
    const target = ev.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.name === "table-visibility") {
      const codeEl = $("create-code") as HTMLInputElement | null;
      if (codeEl) codeEl.hidden = target.value !== "code";
    }
  });

  const readCreateVisibility = (): Visibility => {
    const codeChosen = (
      screenEl.querySelector('input[name="table-visibility"][value="code"]') as HTMLInputElement | null
    )?.checked;
    if (!codeChosen) return { open: null };
    const codeEl = $("create-code") as HTMLInputElement | null;
    return { code: codeEl?.value ?? "" };
  };

  // "" for a game with no `variantChoices` (no picker rendered).
  const readCreateVariant = (): string =>
    (screenEl.querySelector('input[name="table-variant"]:checked') as HTMLInputElement | null)?.value ?? "";

  // Set right before `dispatch()` for a protected row's seat; read once by
  // the `joinTable` branch and cleared.
  let pendingJoinCode: string | null = null;

  // One delegated listener, so re-rendering never leaks handlers.
  screenEl.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const b = target.closest("button") as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    const dispatch = () => {
      beginButtonLoading(b);
      if (b.dataset.createTable) {
        // An empty code would be unreachable by construction; catch it
        // here with a message that names the problem.
        const visibility = readCreateVisibility();
        if ("code" in visibility && visibility.code.length === 0) {
          endButtonLoading();
          showError("Enter an access code, or choose Open.");
          return;
        }
        // Disable new-sid the moment the request goes out.
        setNewSidDisabled(true);
        doCreateTable(b.dataset.createTable as SeatTag, visibility, readCreateVariant());
      } else if (b.dataset.joinTable && b.dataset.joinTableId) {
        const code = pendingJoinCode;
        pendingJoinCode = null;
        setNewSidDisabled(true);
        doJoinTable(BigInt(b.dataset.joinTableId), b.dataset.joinTable as SeatTag, code ? [code] : []);
      } else if (b.dataset.act) doSubmit(JSON.parse(b.dataset.act));
      else if ("rematch" in b.dataset) doRematch();
      else if ("leave" in b.dataset) doLeave();
      else if ("reset" in b.dataset) doReset();
      else if ("claimWin" in b.dataset) doClaimWin();
      else if ("ack" in b.dataset) doAck();
    };
    if (b.dataset.confirm) showConfirm(b.dataset.confirm, dispatch);
    else if ("protected" in b.dataset) {
      showCodePrompt((code) => {
        pendingJoinCode = code;
        dispatch();
      });
    } else dispatch();
  });

  // A sync ping, not a mutation: no `inFlight`/spinner.
  function refresh(): void {
    if (inFlight) return;
    sendWs({ status: null });
  }

  // Last status drawn: a push delivering the same status skips the redraw
  // (replacing innerHTML recreates every button and blinks hover states).
  let lastStatus: unknown;

  const idleTicker = makeCountdownTicker(DUEL_IDLE_WARNING_ID);
  const reclaimTicker = makeCountdownTicker(DUEL_RECLAIM_WARNING_ID);
  const claimTicker = makeCountdownTicker(DUEL_CLAIM_WARNING_ID);
  const claimButtonTicker = makeVisibilityTicker(DUEL_CLAIM_BUTTON_ID);
  const waitTicker = makeTableWaitTicker(screenEl);

  // Re-baselines off a fresh `#inGame` push; stops for any other phase and
  // for a player who already locked in (the warning stays hidden for them).
  function syncIdleTick(status: unknown): void {
    const inGame = inGameView(status);
    if (!inGame || inGame.youSubmitted) {
      idleTicker.sync(null);
      return;
    }
    idleTicker.sync({
      secs: inGame.secondsUntilIdleReset,
      hidden: (secondsLeft) => secondsLeft > idleWarningThreshold(inGame.idleTimeoutSecs),
      text: idleWarningText,
    });
  }

  function syncReclaimTick(status: unknown): void {
    const staging = stagingYouView(status);
    if (!staging) {
      reclaimTicker.sync(null);
      return;
    }
    reclaimTicker.sync({
      secs: staging.secondsUntilReclaimable,
      hidden: (secondsLeft) => secondsLeft > RECLAIM_WARNING_SECS,
      text: reclaimWarningText,
    });
  }

  // Both roles read the same clock: "waiting" (I submitted, they haven't)
  // gets the countdown and, once elapsed, the button; "atRisk" (the
  // mirror) gets the warning only.
  function syncClaimTick(status: unknown): void {
    const inGame = inGameView(status);
    const role: "waiting" | "atRisk" | null = !inGame
      ? null
      : inGame.youSubmitted
        ? (inGame.oppSubmitted ? null : "waiting")
        : (inGame.oppSubmitted ? "atRisk" : null);
    if (!inGame || role === null) {
      claimTicker.sync(null);
      claimButtonTicker.sync(null);
      return;
    }
    const threshold = claimWarningThreshold(inGame.claimTimeoutSecs);
    claimTicker.sync({
      secs: inGame.secondsUntilClaimable,
      hidden: (secondsLeft) =>
        (role === "waiting" && secondsLeft <= 0n) || secondsLeft > threshold,
      text: role === "waiting" ? claimWarningText : atRiskWarningText,
    });
    if (role === "waiting") {
      claimButtonTicker.sync({ secs: inGame.secondsUntilClaimable });
    } else {
      claimButtonTicker.sync(null);
    }
  }

  // The create-table form is live user input a redraw would reset to its
  // defaults — an unrelated push mid-fill must not silently revert
  // "Protected" to "Open" or a variant pick. Captured before the redraw,
  // restored after.
  interface CreateFormState {
    visibility: string; // "open" | "code"
    code: string;
    variant: string | null; // null when this game has no variant picker
  }

  const captureCreateFormState = (): CreateFormState | null => {
    const radio = screenEl.querySelector(
      'input[name="table-visibility"]:checked',
    ) as HTMLInputElement | null;
    if (!radio) return null;
    return {
      visibility: radio.value,
      code: ($("create-code") as HTMLInputElement | null)?.value ?? "",
      variant: (
        screenEl.querySelector('input[name="table-variant"]:checked') as HTMLInputElement | null
      )?.value ?? null,
    };
  };

  const restoreCreateFormState = (saved: CreateFormState): void => {
    // Both radios set explicitly: the fresh markup's own default would
    // otherwise still read as checked.
    const openRadio = screenEl.querySelector(
      'input[name="table-visibility"][value="open"]',
    ) as HTMLInputElement | null;
    const codeRadio = screenEl.querySelector(
      'input[name="table-visibility"][value="code"]',
    ) as HTMLInputElement | null;
    if (!openRadio && !codeRadio) return;
    if (openRadio) openRadio.checked = saved.visibility === "open";
    if (codeRadio) codeRadio.checked = saved.visibility === "code";
    const codeEl = $("create-code") as HTMLInputElement | null;
    if (codeEl) {
      codeEl.value = saved.code;
      codeEl.hidden = saved.visibility !== "code";
    }
    if (saved.variant !== null) {
      for (const r of screenEl.querySelectorAll('input[name="table-variant"]')) {
        (r as HTMLInputElement).checked = (r as HTMLInputElement).value === saved.variant;
      }
    }
  };

  const renderIfChanged = (status: unknown): void => {
    setNewSidDisabled(joinPending() || isSeated(status));
    if (deepEqual(status, lastStatus)) return;
    lastStatus = status;
    const savedForm = captureCreateFormState();
    screenEl.innerHTML = renderStatus(status as Parameters<typeof renderStatus<S>>[0], plugin);
    if (savedForm) restoreCreateFormState(savedForm);
    syncIdleTick(status);
    syncReclaimTick(status);
    syncClaimTick(status);
    waitTicker.sync();
    applyLoadingState();
  };

  screenEl.innerHTML = `<p class="duel-connecting">Connecting…</p>`;
  ws.onopen = () => refresh();
  ws.onmessage = (ev) => {
    const msg = ev.data;
    const staleJoin = "err" in msg && isStaleJoin(lastReq, msg.err);
    const staleMutation = "err" in msg && isStaleMutation(lastReq, msg.err);

    // A correlating transport already settled the spinner off its own
    // reply; the fallback has only this signal — except a stale join/
    // mutation, which must clear the spinner before `refresh()` (a no-op
    // while `inFlight`).
    if (!canCorrelate || staleJoin || staleMutation) {
      inFlight = false;
      document.body.classList.remove("working");
      endButtonLoading();
    }
    if ("err" in msg) {
      if (staleJoin || staleMutation) {
        refresh();
        return;
      }
      showError(errText(msg.err));
      syncNewSidBtn();
    } else {
      renderIfChanged(msg.view);
    }
  };
  ws.onerror = (ev) => showError(`WebSocket error: ${ev?.error?.message ?? ev}`);
  ws.onclose = () => showDisconnected();
}
