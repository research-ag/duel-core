// 007's own UI over duel-game-core's headless client: a paper dossier.
// Every screen, the sidebar (agent identity, channel light, running
// mission log), the alert strip, the two dialogs, and the local clocks
// are this file's. Nothing here comes from `duel-game-core/render.js`
// except `esc`; the in-game board and action buttons are still
// `duel007-plugin.js`'s. See ../../../../frontend/README.md, "The
// headless client".

import { claimRoleOf, localSecondsElapsed, localSecondsLeft, oppSeatOf, tag, viewOf, withLocalMove } from "duel-game-core/client.js";
import { esc } from "duel-game-core/render.js";

const IDLE_WARNING_SECS = 30n;
const CLAIM_WARNING_SECS = 15n;
const RECLAIM_WARNING_SECS = 15n;
const LOG_KEEP = 8;

const fileNo = (id) => `OP-${String(id).padStart(3, "0")}`;

// ── Screens ──────────────────────────────────────────────────────────────

function seatCell(plugin, seat, attrs, open, occupant) {
  if (open) {
    return `<td><button class="stamp" ${attrs}>Take ${esc(plugin.seatLabel(seat))}</button></td>`;
  }
  const who = occupant && occupant.length === 1 ? occupant[0] : "";
  return `<td class="taken" title="${esc(who)}">${esc(plugin.seatLabel(seat))} · ${who ? esc(who.slice(0, 10)) + "…" : "taken"}</td>`;
}

function opRow(plugin, r) {
  const attrs = (seat) =>
    `data-op="join" data-table="${r.id}" data-seat="${seat}" data-key="jointable:${r.id}:${seat}"${r.protected ? " data-protected" : ""}`;
  return `
    <tr>
      <th scope="row">${fileNo(r.id)}</th>
      <td>${r.protected ? `<span class="tag">CODED</span>` : `<span class="tag open">OPEN</span>`}</td>
      <td class="clock" data-clock="wait" data-base="${r.waitingSecs}">standing by ${r.waitingSecs}s</td>
      ${seatCell(plugin, "p1", attrs("p1"), r.p1Open, r.p1Session)}
      ${seatCell(plugin, "p2", attrs("p2"), r.p2Open, r.p2Session)}
    </tr>`;
}

function missionBoard(v, plugin) {
  return `
    <h1 class="tw">Mission index</h1>
    <form class="file-new" onsubmit="return false">
      <p class="lbl">File a new operation</p>
      <div class="fields">
        <fieldset>
          <legend>Your cover</legend>
          <label><input type="radio" name="op-seat" value="p1" checked /> ${esc(plugin.seatLabel("p1"))}</label>
          <label><input type="radio" name="op-seat" value="p2" /> ${esc(plugin.seatLabel("p2"))}</label>
        </fieldset>
        <fieldset>
          <legend>Channel</legend>
          <label><input type="radio" name="op-visibility" value="open" checked /> Open</label>
          <label><input type="radio" name="op-visibility" value="code" /> Coded</label>
          <input type="text" id="op-code" placeholder="access code" hidden />
        </fieldset>
        <button class="stamp big" data-op="create" data-key="create:p1">File it</button>
      </div>
    </form>
    <h2 class="tw">Active operations</h2>
    ${
      v.tables.length === 0
        ? `<p class="faint">Nothing on file. File one above.</p>`
        : `<table class="index">
        <thead><tr><th>File</th><th>Channel</th><th>Status</th><th>${esc(plugin.seatLabel("p1"))}</th><th>${esc(plugin.seatLabel("p2"))}</th></tr></thead>
        <tbody>${v.tables.map((r) => opRow(plugin, r)).join("")}</tbody>
      </table>`
    }`;
}

function tableLobby(id, v, plugin) {
  const attrs = (seat) => `data-op="join" data-table="${id}" data-seat="${seat}" data-key="jointable:${id}:${seat}"`;
  return `
    <h1 class="tw">${fileNo(id)}</h1>
    <p>This file is open. Take a cover to proceed.</p>
    <table class="index">
      <thead><tr><th>${esc(plugin.seatLabel("p1"))}</th><th>${esc(plugin.seatLabel("p2"))}</th></tr></thead>
      <tbody><tr>${seatCell(plugin, "p1", attrs("p1"), v.p1Open)}${seatCell(plugin, "p2", attrs("p2"), v.p2Open)}</tr></tbody>
    </table>
    ${v.resetAvailable ? `<button class="plain" data-op="reset" data-key="reset">Clear the abandoned file</button>` : ""}`;
}

function busy(id, v) {
  return `
    <h1 class="tw">${fileNo(id)}</h1>
    <div class="notice">
      <p>Two agents are already on this file.</p>
      <p class="clock" data-clock="busy" data-base="${v.secondsUntilTakeover}">It can be commandeered in ${v.secondsUntilTakeover}s.</p>
    </div>`;
}

function safeHouse(id, v, plugin) {
  const seat = tag(v.seat);
  const code = "code" in v.visibility ? v.visibility.code : null;
  const brief = v.reservedForPartner
    ? `The other cover is on hold for your last opposite number. After that, anyone may take it.`
    : code !== null
      ? `Coded channel. Your contact needs the file number and the code below.`
      : `Open channel. A second tab, or anyone on the index, can take the other cover.`;
  return `
    <h1 class="tw">${fileNo(id)}</h1>
    <div class="notice">
      <p class="lbl">Standing by</p>
      <p>You are <strong>${esc(plugin.seatLabel(seat))}</strong>. ${brief}</p>
      ${code !== null ? `<p><span class="lbl">Code</span> <code class="code">${esc(code)}</code></p>` : ""}
      <p class="clock warn" data-clock="reclaim" data-base="${v.secondsUntilReclaimable}" ${v.secondsUntilReclaimable > RECLAIM_WARNING_SECS ? "hidden" : ""}></p>
      <button class="plain" data-op="leave" data-key="leave">Withdraw</button>
    </div>`;
}

function rematchOffer(v, plugin) {
  return `
    <h1 class="tw">Rematch proposed</h1>
    <div class="notice">
      <p>Your last opposite number has reopened the file and is holding <strong>${esc(plugin.seatLabel(tag(v.openSeat)))}</strong> for you.</p>
      <p class="row">
        <button class="stamp" data-op="rematch" data-key="rematch">Accept</button>
        <button class="plain" data-op="leave" data-key="leave">Decline</button>
      </p>
    </div>`;
}

function inGame(v, plugin) {
  const me = tag(v.seat);
  const opp = plugin.seatLabel(oppSeatOf(me));
  const role = claimRoleOf(v);
  return `
    <div class="strip">
      <span class="tw">Round ${v.turn + 1n}</span>
      <span class="${v.oppSubmitted ? "ok" : "faint"}">${v.oppSubmitted ? `${esc(opp)} has committed` : `${esc(opp)} is deciding…`}</span>
      <button class="plain small" data-op="forfeit">Forfeit</button>
    </div>
    <div class="stage">${plugin.renderBoard(v.game, me, oppSeatOf(me), !v.youSubmitted)}</div>
    ${
      v.youSubmitted
        ? `<p class="notice ok">Your order is in. Waiting for the other side…</p>`
        : `<p class="lbl">Your order this round</p><div class="orders">${plugin.renderActions(v.game, me)}</div>`
    }
    ${v.youSubmitted ? "" : `<p class="clock warn" data-clock="idle" data-base="${v.secondsUntilIdleReset}" hidden></p>`}
    ${
      role === null
        ? ""
        : `<p class="clock warn" data-clock="claim" data-role="${role}" data-base="${v.secondsUntilClaimable}" hidden></p>
           ${role === "waiting" ? `<p><button class="stamp" data-op="claim" data-key="claim-win" data-clock="claim-button" data-base="${v.secondsUntilClaimable}" ${v.claimWinAvailable ? "" : "hidden"}>Claim the win</button></p>` : ""}`
    }`;
}

function verdict(end, me) {
  const t = tag(end);
  if (t === "finished") {
    const who = tag(end.finished);
    if (who === "draw") return { title: "Mutual destruction", outcome: "draw", note: "Both agents down." };
    if (who === `${me}Wins`) return { title: "Mission accomplished", outcome: "win", note: "The target is neutralised." };
    return { title: "Agent down", outcome: "lose", note: "You did not make it out." };
  }
  if (t === "claimed") {
    return tag(end.claimed) === me
      ? { title: "Mission accomplished", outcome: "win", note: "The other side went dark. You claimed the win." }
      : { title: "Agent down", outcome: "lose", note: "You went dark, and the win was claimed." };
  }
  return { title: "Withdrawn", outcome: "draw", note: tag(end.aborted) === me ? "Mission aborted by you." : "Mission aborted by the other side." };
}

function debrief(v, plugin) {
  const me = tag(v.seat);
  const { title, outcome, note } = verdict(v.end, me);
  return `
    <div class="strip">
      <span class="tw">Debrief</span>
      <span class="faint">${v.turns} round${v.turns === 1n ? "" : "s"}</span>
    </div>
    <div class="stamp-box ${outcome}"><span>${title}</span></div>
    <p class="center">${note}</p>
    <div class="stage">${plugin.renderBoard(v.finalGame, me, oppSeatOf(me))}</div>
    <p class="row">
      <button class="stamp" data-op="rematch" data-key="rematch">Reopen the file</button>
      <button class="plain" data-op="leave" data-key="leave">Back to the index</button>
    </p>`;
}

function endedByOther() {
  return `
    <h1 class="tw">File closed</h1>
    <div class="notice">
      <p>The board sat idle too long and was reassigned to other agents.</p>
      <button class="stamp" data-op="ack" data-key="ack">Acknowledge</button>
    </div>`;
}

export function renderScreen(status, plugin) {
  if (status === null) return `<p class="faint">Establishing a secure channel…</p>`;
  if ("browsing" in status) return missionBoard(status.browsing, plugin);
  const { id, view } = status.atTable;
  const t = tag(view);
  const v = view[t];
  switch (t) {
    case "lobby":
      return tableLobby(id, v, plugin);
    case "busy":
      return busy(id, v);
    case "stagingYou":
      return safeHouse(id, v, plugin);
    case "awaitingRematch":
      return rematchOffer(v, plugin);
    case "inGame":
      return inGame(v, plugin);
    case "debrief":
      return debrief(v, plugin);
    case "endedByOther":
      return endedByOther();
    default:
      return `<p class="alert">Unknown view: ${esc(t)}</p>`;
  }
}

// ── Clocks: patched in place once a second, never a redraw ───────────────

function syncClocks(root, state) {
  const at = state.statusAt;
  for (const el of root.querySelectorAll("[data-clock]")) {
    const base = BigInt(el.dataset.base ?? "0");
    switch (el.dataset.clock) {
      case "wait":
        el.textContent = `standing by ${localSecondsElapsed(base, at)}s`;
        break;
      case "busy":
        el.textContent = `It can be commandeered in ${localSecondsLeft(base, at)}s.`;
        break;
      case "reclaim": {
        const left = localSecondsLeft(base, at);
        el.hidden = left > RECLAIM_WARNING_SECS;
        el.textContent = `Still there? This cover is released ${left <= 0n ? "any moment now" : `in ${left}s`} if the page stays idle.`;
        break;
      }
      case "idle": {
        const left = localSecondsLeft(base, at);
        el.hidden = left > IDLE_WARNING_SECS;
        el.textContent = `Still thinking? The operation is called off ${left <= 0n ? "any moment now" : `in ${left}s`} if nobody moves.`;
        break;
      }
      case "claim": {
        const left = localSecondsLeft(base, at);
        const waiting = el.dataset.role === "waiting";
        el.hidden = (waiting && left <= 0n) || left > CLAIM_WARNING_SECS;
        el.textContent = waiting
          ? `The other side has not moved. You can claim the win ${left <= 0n ? "now" : `in ${left}s`}.`
          : `You have not moved. The other side can claim the win ${left <= 0n ? "now" : `in ${left}s`}.`;
        break;
      }
      case "claim-button":
        el.hidden = localSecondsLeft(base, at) > 0n;
        break;
    }
  }
}

// ── Mounting ─────────────────────────────────────────────────────────────

export function mountMissionUi({ client, plugin, els }) {
  const { screen, alert, sid, newSid, auth, channel, log, confirmDialog, codeDialog } = els;
  const session = client.session;

  sid.textContent = client.sid;
  if (!session.regenerate || session.isLoggedIn) newSid.hidden = true;
  else newSid.addEventListener("click", () => void client.regenerateSid());
  if (session.login && session.logout) {
    auth.textContent = session.isLoggedIn ? "Log out" : "Log in";
    auth.hidden = false;
    auth.addEventListener("click", () => void (session.isLoggedIn ? client.logout() : client.login()));
  }

  // Resolves off the dialog's own buttons (Enter picks the first one) or
  // Escape; every path closes it.
  const ask = (dialog, resolveWith) =>
    new Promise((resolve) => {
      const finish = (value) => {
        dialog.removeEventListener("click", onClick);
        dialog.removeEventListener("cancel", onCancel);
        if (dialog.open) dialog.close();
        resolve(resolveWith(value));
      };
      const onClick = (ev) => {
        const b = ev.target.closest("button[value]");
        if (!b) return;
        ev.preventDefault();
        finish(b.value);
      };
      const onCancel = (ev) => {
        ev.preventDefault();
        finish("");
      };
      dialog.addEventListener("click", onClick);
      dialog.addEventListener("cancel", onCancel);
      dialog.showModal();
    });
  const confirmForfeit = () => ask(confirmDialog, (rv) => rv === "yes");
  const askCode = () => {
    codeDialog.querySelector("input").value = "";
    return ask(codeDialog, (rv) => (rv === "join" ? codeDialog.querySelector("input").value : null));
  };

  screen.addEventListener("change", (ev) => {
    if (ev.target.name === "op-visibility") screen.querySelector("#op-code").hidden = ev.target.value !== "code";
  });

  const createSeat = () => screen.querySelector('input[name="op-seat"]:checked')?.value ?? "p1";
  const createVisibility = () => {
    const coded = screen.querySelector('input[name="op-visibility"][value="code"]')?.checked;
    return coded ? { code: screen.querySelector("#op-code")?.value ?? "" } : { open: null };
  };

  screen.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button");
    if (!b || b.disabled || client.getState().pending) return;
    if (b.dataset.act) return void client.submit(JSON.parse(b.dataset.act));
    switch (b.dataset.op) {
      case "create": {
        const visibility = createVisibility();
        if ("code" in visibility && visibility.code === "") return client.showError("Set an access code, or use an open channel.");
        const seat = createSeat();
        b.dataset.key = `create:${seat}`;
        return void client.createTable(seat, visibility, "");
      }
      case "join": {
        let code = null;
        if ("protected" in b.dataset) {
          code = await askCode();
          if (code === null) return;
        }
        return void client.joinTable(BigInt(b.dataset.table), b.dataset.seat, code);
      }
      case "forfeit":
        if (await confirmForfeit()) void client.leave();
        return;
      case "leave":
        return void client.leave();
      case "rematch":
        return void client.rematch();
      case "reset":
        return void client.reset();
      case "claim":
        return void client.claimWin();
      case "ack":
        return void client.ackEnded();
    }
  });

  // Every `data-key`/`data-act` button is disabled while a call is out;
  // the one that issued it spins.
  function syncButtons(state) {
    const key = state.pending?.key ?? null;
    const dead = state.connection === "closed";
    for (const b of screen.querySelectorAll("button")) {
      if (b.dataset.naturallyOff === undefined) b.dataset.naturallyOff = b.disabled ? "1" : "0";
      const ownKey = b.dataset.key ?? (b.dataset.act !== undefined ? `act:${b.dataset.act}` : null);
      b.disabled = dead || key !== null || b.dataset.naturallyOff === "1";
      b.classList.toggle("spinning", key !== null && ownKey === key);
    }
  }

  function syncAlert(state) {
    if (state.connection === "closed") {
      alert.innerHTML = `Secure channel lost. <button class="plain" id="reload">Reconnect</button>`;
      alert.hidden = false;
      alert.querySelector("#reload").addEventListener("click", () => location.reload());
      return;
    }
    alert.hidden = state.error === null;
    alert.textContent = state.error ?? "";
  }

  function syncChannel(state) {
    const mode =
      state.connection === "closed" ? "closed" : state.pending !== null ? "pending" : state.connection === "open" ? "open" : "connecting";
    channel.dataset.mode = mode;
    channel.textContent = { closed: "Channel lost", pending: "Transmitting…", open: "Channel secure", connecting: "Connecting…" }[mode];
  }

  function syncIdentity(state) {
    newSid.disabled = state.identityLocked;
    auth.disabled = state.identityLocked;
  }

  // The round log: one line per round of the game in progress, taken
  // from the narration each push carries in `lastRound`. In memory only,
  // for this tab, cleared on leaving the table.
  let logTable = null;
  let logLines = [];
  function syncLog(state) {
    const at = state.status && "atTable" in state.status ? state.status.atTable : null;
    if (at === null || at.id !== logTable) {
      logTable = at === null ? null : at.id;
      logLines = [];
    }
    const live = viewOf(state.status, "inGame");
    const done = viewOf(state.status, "debrief");
    const game = live ? live.game : done ? done.finalGame : null;
    const round = live ? live.turn : done ? done.turns : null;
    const last = game && game.lastRound.length === 1 ? game.lastRound[0] : null;
    if (last && !logLines.some((l) => l.round === round)) {
      logLines.push({ round, text: last.narration });
      if (logLines.length > LOG_KEEP) logLines.shift();
    }
    log.innerHTML =
      logLines.length === 0
        ? `<li class="faint">No rounds yet.</li>`
        : logLines.map((l) => `<li><span class="tw">R${l.round}</span> ${esc(l.text)}</li>`).join("");
  }

  // An order in flight already shows as committed (`plugin.applyLocal`).
  const shownStatus = (state) => withLocalMove(state.status, state.pending, plugin.applyLocal.bind(plugin));

  // The new-operation form is live input; keep it across an unrelated
  // redraw (another agent's file appearing on the index).
  function redraw(state) {
    const seat = screen.querySelector('input[name="op-seat"]:checked')?.value;
    const coded = screen.querySelector('input[name="op-visibility"][value="code"]')?.checked ?? false;
    const code = screen.querySelector("#op-code")?.value ?? "";
    screen.innerHTML = renderScreen(shownStatus(state), plugin);
    const seatRadio = seat && screen.querySelector(`input[name="op-seat"][value="${seat}"]`);
    if (seatRadio) seatRadio.checked = true;
    const codeRadio = screen.querySelector('input[name="op-visibility"][value="code"]');
    if (codeRadio && coded) {
      codeRadio.checked = true;
      const input = screen.querySelector("#op-code");
      input.hidden = false;
      input.value = code;
    }
    syncClocks(screen, state);
    syncLog(state);
  }

  redraw(client.getState());
  syncChannel(client.getState());
  client.subscribe((state, prev) => {
    if (state.status !== prev.status || (state.pending !== prev.pending && shownStatus(state) !== shownStatus(prev))) redraw(state);
    document.body.classList.toggle("working", state.pending !== null);
    syncButtons(state);
    syncChannel(state);
    if (state.identityLocked !== prev.identityLocked) syncIdentity(state);
    if (state.error !== prev.error || state.connection !== prev.connection) syncAlert(state);
  });
  setInterval(() => syncClocks(screen, client.getState()), 1000);
}
