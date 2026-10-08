// The default UI shell: `start()` creates a headless client (client.ts),
// draws its state with the default screens (render.ts) into `#screen`,
// and dispatches delegated clicks back to the client. It owns nothing but
// DOM: the header controls, the error banner, the per-button spinner, the
// local countdown tickers, the confirm and access-code overlays. A game
// swaps any screen (`screens`), either overlay (`confirm`/`promptCode`),
// or skips this file entirely and binds `createDuelClient` to its own UI.
// See ../README.md, "Wiring it up".

import { createDuelClient, claimRoleOf, viewOf, withLocalMove } from "./client.js";
import type { ClientState, DuelClient, SessionIdentity } from "./client.js";
import {
  renderStatus,
  resolveScreens,
  DUEL_IDLE_WARNING_ID,
  idleWarningThreshold,
  idleWarningText,
  DUEL_CLAIM_WARNING_ID,
  DUEL_CLAIM_BUTTON_ID,
  claimWarningText,
  atRiskWarningText,
  claimWarningThreshold,
  waitingText,
} from "./render.js";
import type { Screens } from "./render.js";
import type { Transport, GamePlugin, InGameView, SeatTag, Status, Visibility } from "./types.js";

export type { SessionIdentity } from "./client.js";

const $ = (id: string): HTMLElement | null => document.getElementById(id);

/// A once-per-second local countdown for a warning element. `secondsUntilX`
/// fields are only as fresh as the last push (nothing pushes on a bare
/// tick), so this patches `hidden`/`textContent` in place without touching
/// `screenEl.innerHTML` (which would reintroduce hover flicker).
function makeCountdownTicker(elId: string) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let baseline:
    | {
        secs: bigint;
        atMs: number;
        hidden: (secondsLeft: bigint) => boolean;
        text: (secondsLeft: bigint) => string;
      }
    | undefined;

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

/// Like `makeCountdownTicker`, but only toggles `hidden`: safe for an
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

// The two overlays, each appended to `<body>` (not `screenEl`) so it
// survives redraws and a game's click-through overlay CSS, and each
// replaceable through `start()`'s `confirm`/`promptCode`.

type Confirm = (msg: string, then: (yes: boolean) => void) => void;
type PromptCode = (then: (code: string | null) => void) => void;

function makeConfirmOverlay(): Confirm {
  const overlay = document.createElement("div");
  overlay.className = "duel-confirm-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="duel-confirm-box">
      <p class="duel-confirm-msg"></p>
      <div class="duel-confirm-actions">
        <button type="button" class="ghost" data-confirm-no>Cancel</button>
        <button type="button" class="primary" data-confirm-yes>Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const msgEl = overlay.querySelector(".duel-confirm-msg") as HTMLElement;
  let pending: ((yes: boolean) => void) | null = null;
  overlay.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const yes = "confirmYes" in target.dataset;
    if (!yes && target !== overlay && !("confirmNo" in target.dataset)) return;
    const fn = pending;
    pending = null;
    overlay.hidden = true;
    if (fn) fn(yes);
  });
  return (msg, then) => {
    msgEl.textContent = msg;
    pending = then;
    overlay.hidden = false;
  };
}

function makeCodePrompt(): PromptCode {
  const overlay = document.createElement("div");
  overlay.className = "duel-code-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="duel-code-box">
      <p class="duel-code-msg">This table is protected — enter its access code to join.</p>
      <input type="text" class="duel-code-input" placeholder="access code" />
      <div class="duel-code-actions">
        <button type="button" class="ghost" data-code-cancel>Cancel</button>
        <button type="button" class="primary" data-code-join>Join</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const inputEl = overlay.querySelector(".duel-code-input") as HTMLInputElement;
  let pending: ((code: string | null) => void) | null = null;
  overlay.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const join = "codeJoin" in target.dataset;
    if (!join && target !== overlay && !("codeCancel" in target.dataset)) return;
    const fn = pending;
    pending = null;
    overlay.hidden = true;
    if (fn) fn(join ? inputEl.value : null);
  });
  return (then) => {
    inputEl.value = "";
    pending = then;
    overlay.hidden = false;
    inputEl.focus?.();
  };
}

export interface StartOptions<S = unknown> {
  plugin: GamePlugin<S>;
  transport: Transport<S>;
  /// Required: every legal `sid` is principal-bound.
  session: SessionIdentity;
  /// Any subset of the default screens, replaced.
  screens?: Partial<Screens<S>>;
  /// Replaces the confirmation modal (`data-confirm` buttons).
  confirm?: (msg: string) => Promise<boolean>;
  /// Replaces the access-code prompt (`data-protected` seat buttons);
  /// resolves `null` to cancel.
  promptCode?: () => Promise<string | null>;
  errorTtlMs?: number;
  sidElId?: string;
  newSidBtnId?: string;
  screenElId?: string;
  errorElId?: string;
  authBtnId?: string;
}

/// The click-content key of a button, matching `PendingCall.key` for the
/// request that button dispatches.
export function buttonKey(b: HTMLButtonElement): string {
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

export function start<S>({
  plugin,
  transport,
  session,
  screens,
  confirm,
  promptCode,
  errorTtlMs,
  sidElId = "sid",
  newSidBtnId = "new-sid",
  screenElId = "screen",
  errorElId = "error",
  authBtnId = "duel-auth-btn",
}: StartOptions<S>): DuelClient<S> {
  if (!plugin) throw new Error("start(): `plugin` is required");
  if (!transport) throw new Error("start(): `transport` is required");
  if (!session) throw new Error("start(): `session` is required");

  const screenEl = $(screenElId);
  if (!screenEl) throw new Error(`start(): no element with id "${screenElId}"`);

  // `sessionStorage["sid"]` is where game code outside `start()` (a second
  // bundle sharing the connection) reads the sid.
  sessionStorage.setItem("sid", session.sid);
  const sidEl = $(sidElId);
  if (sidEl) sidEl.textContent = session.sid;

  const client = createDuelClient<S>({ transport, session, errorTtlMs });
  const sc = resolveScreens(screens);
  const askConfirm: Confirm = confirm ? (msg, then) => void confirm(msg).then(then) : makeConfirmOverlay();
  const askCode: PromptCode = promptCode ? (then) => void promptCode().then(then) : makeCodePrompt();

  // Header controls.

  const newSidBtn = $(newSidBtnId) as HTMLButtonElement | null;
  if (newSidBtn) {
    if (!session.regenerate || session.isLoggedIn) {
      newSidBtn.disabled = true;
      newSidBtn.hidden = true;
    } else {
      newSidBtn.addEventListener("click", () => {
        if (newSidBtn.disabled) return;
        void client.regenerateSid();
      });
    }
  }

  const authBtn = $(authBtnId) as HTMLButtonElement | null;
  const authWired = !!(authBtn && session.login && session.logout);
  if (authBtn && authWired) {
    authBtn.textContent = session.isLoggedIn ? "Log out" : "Log in with Internet Identity";
    authBtn.disabled = false;
    authBtn.addEventListener("click", () => {
      if (authBtn.disabled) return;
      void (session.isLoggedIn ? client.logout() : client.login());
    });
  }

  const syncIdentityControls = (state: ClientState<S>): void => {
    const locked = state.identityLocked;
    if (newSidBtn) newSidBtn.disabled = locked;
    if (authBtn && authWired) authBtn.disabled = locked;
  };

  // Error banner.

  const errorEl = $(errorElId);
  const syncError = (state: ClientState<S>): void => {
    if (!errorEl) return;
    if (state.connection === "closed") {
      errorEl.innerHTML = `Connection closed. <button type="button" class="ghost" id="duel-reload">Reload to reconnect</button>`;
      errorEl.hidden = false;
      $("duel-reload")?.addEventListener("click", () => location.reload());
      return;
    }
    if (state.error === null && state.connection === "reconnecting") {
      errorEl.textContent = "Reconnecting…";
      errorEl.hidden = false;
      return;
    }
    if (state.error === null) {
      errorEl.hidden = true;
      return;
    }
    errorEl.textContent = state.error;
    errorEl.hidden = false;
  };

  // Per-button loading spinner (`button.duel-loading`). Keyed by what the
  // button does, not the node, and reapplied after EVERY render: an
  // unrelated push mid-flight replaces `screenEl.innerHTML` and would
  // otherwise lose the spinner while the call is still outstanding.
  // Each button's server-driven disabled state is stashed in
  // `dataset.naturalDisabled` on first sight so it can be restored.

  const applyLoadingState = (state: ClientState<S>): void => {
    const pendingKey = state.pending?.key ?? null;
    const disconnected = state.connection === "closed";
    for (const btn of screenEl.querySelectorAll("button")) {
      const el = btn as HTMLButtonElement;
      if (el.dataset.naturalDisabled === undefined) {
        el.dataset.naturalDisabled = el.disabled ? "1" : "0";
      }
      if (disconnected) {
        el.disabled = true;
        el.classList.remove("duel-loading");
      } else if (pendingKey !== null) {
        el.disabled = true;
        el.classList.toggle("duel-loading", buttonKey(el) === pendingKey);
      } else {
        el.disabled = el.dataset.naturalDisabled === "1";
        el.classList.remove("duel-loading");
      }
    }
  };

  // The clicked button is marked directly as well: a minimal test DOM has
  // no querySelectorAll, and the real one may not list it either.
  let directBtn: HTMLButtonElement | null = null;

  const markDirect = (b: HTMLButtonElement): void => {
    directBtn = b;
    if (b.dataset.naturalDisabled === undefined) b.dataset.naturalDisabled = b.disabled ? "1" : "0";
    b.disabled = true;
    b.classList.add("duel-loading");
  };

  const unmarkDirect = (): void => {
    if (directBtn?.isConnected) {
      directBtn.disabled = directBtn.dataset.naturalDisabled === "1";
      directBtn.classList.remove("duel-loading");
    }
    directBtn = null;
  };

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

  // One delegated listener, so re-rendering never leaks handlers.
  screenEl.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const b = target.closest("button") as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    if (client.getState().pending !== null) return;
    const dispatch = (code: string | null = null): void => {
      let p: Promise<unknown> | null = null;
      if (b.dataset.createTable) {
        // An empty code would be unreachable by construction; catch it
        // here with a message that names the problem.
        const visibility = readCreateVisibility();
        if ("code" in visibility && visibility.code.length === 0) {
          client.showError("Enter an access code, or choose Open.");
          return;
        }
        p = client.createTable(b.dataset.createTable as SeatTag, visibility, readCreateVariant());
      } else if (b.dataset.joinTable && b.dataset.joinTableId) {
        p = client.joinTable(BigInt(b.dataset.joinTableId), b.dataset.joinTable as SeatTag, code);
      } else if (b.dataset.act) p = client.submit(JSON.parse(b.dataset.act));
      else if ("rematch" in b.dataset) p = client.rematch();
      else if ("leave" in b.dataset) p = client.leave();
      else if ("reset" in b.dataset) p = client.reset();
      else if ("claimWin" in b.dataset) p = client.claimWin();
      else if ("ack" in b.dataset) p = client.ackEnded();
      if (p !== null && client.getState().pending?.key === buttonKey(b)) markDirect(b);
    };
    if (b.dataset.confirm) {
      askConfirm(b.dataset.confirm, (yes) => {
        if (yes) dispatch();
      });
    } else if ("protected" in b.dataset) {
      askCode((code) => {
        if (code !== null) dispatch(code);
      });
    } else dispatch();
  });

  // Local countdowns, re-baselined off every fresh push.

  const idleTicker = makeCountdownTicker(DUEL_IDLE_WARNING_ID);
  const claimTicker = makeCountdownTicker(DUEL_CLAIM_WARNING_ID);
  const claimButtonTicker = makeVisibilityTicker(DUEL_CLAIM_BUTTON_ID);
  const waitTicker = makeTableWaitTicker(screenEl);

  // Stops for any other phase and for a player who already locked in (the
  // warning stays hidden for them).
  function syncIdleTick(status: Status<S> | null): void {
    const inGame = viewOf<InGameView<S>>(status, "inGame");
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

  // Both roles read the same clock: "waiting" (I submitted, they haven't)
  // gets the countdown and, once elapsed, the button; "atRisk" (the
  // mirror) gets the warning only.
  function syncClaimTick(status: Status<S> | null): void {
    const inGame = viewOf<InGameView<S>>(status, "inGame");
    const role = inGame ? claimRoleOf(inGame) : null;
    if (!inGame || role === null) {
      claimTicker.sync(null);
      claimButtonTicker.sync(null);
      return;
    }
    const threshold = claimWarningThreshold(inGame.claimTimeoutSecs);
    claimTicker.sync({
      secs: inGame.secondsUntilClaimable,
      hidden: (secondsLeft) => (role === "waiting" && secondsLeft <= 0n) || secondsLeft > threshold,
      text: role === "waiting" ? claimWarningText : atRiskWarningText,
    });
    if (role === "waiting") {
      claimButtonTicker.sync({ secs: inGame.secondsUntilClaimable });
    } else {
      claimButtonTicker.sync(null);
    }
  }

  // The create-table form is live user input a redraw would reset to its
  // defaults: an unrelated push mid-fill must not silently revert
  // "Protected" to "Open" or a variant pick. Captured before the redraw,
  // restored after.
  interface CreateFormState {
    visibility: string; // "open" | "code"
    code: string;
    variant: string | null; // null when this game has no variant picker
  }

  const captureCreateFormState = (): CreateFormState | null => {
    const radio = screenEl.querySelector('input[name="table-visibility"]:checked') as HTMLInputElement | null;
    if (!radio) return null;
    return {
      visibility: radio.value,
      code: ($("create-code") as HTMLInputElement | null)?.value ?? "",
      variant:
        (screenEl.querySelector('input[name="table-variant"]:checked') as HTMLInputElement | null)?.value ?? null,
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

  const redraw = (status: Status<S>): void => {
    const savedForm = captureCreateFormState();
    screenEl.innerHTML = renderStatus(status, plugin, sc);
    if (savedForm) restoreCreateFormState(savedForm);
    syncIdleTick(status);
    syncClaimTick(status);
    waitTicker.sync();
  };

  screenEl.innerHTML = sc.connecting();

  // What is on screen: the real status, or it with the pending move
  // already applied (`plugin.applyLocal`).
  let shown: Status<S> | null = null;
  const applyLocal = plugin.applyLocal?.bind(plugin);

  client.subscribe((state, prev) => {
    if (state.status !== prev.status || state.pending !== prev.pending) {
      const next = withLocalMove(state.status, state.pending, applyLocal);
      if (next !== shown && next !== null) redraw(next);
      shown = next;
    }
    if (state.pending !== prev.pending) {
      document.body.classList.toggle("working", state.pending !== null);
      if (state.pending === null) unmarkDirect();
    }
    if (state.status !== prev.status || state.pending !== prev.pending || state.connection !== prev.connection) {
      applyLoadingState(state);
    }
    if (state.identityLocked !== prev.identityLocked) syncIdentityControls(state);
    if (state.error !== prev.error || state.connection !== prev.connection) syncError(state);
  });

  return client;
}
