// Seating a discovered bot, and the default "🤖 Bots" and leaderboard
// overlays. See ../README.md, "Bots and the leaderboard".

import { Actor } from "@icp-sdk/core/agent";
import type { HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";

import { atTableOf, errText, tag, viewOf } from "./client.js";
import type { DuelClient } from "./client.js";
import { buildBotPlayIdlFactory } from "./idl.js";
import { botDisplayName, esc, renderBotList, renderLeaderboard, renderSeatChoice } from "./render.js";
import type { BotInfo, EngineErr, GamePlugin, LeaderboardEntry, Seat, SeatTag, StagingYouView, Status } from "./types.js";

/// One bot at one complexity, as `renderBotList`/`renderLeaderboard`'s
/// Challenge buttons carry it.
export interface BotRef {
  principal: string;
  name: string;
  complexity: string;
}

/// The caller's own table waiting for an opponent: what a bot's `play` needs.
export interface Staging {
  tableId: bigint;
  openSeat: Seat;
  code: [] | [string];
}

/// A bot canister's `play` reply.
export type PlayResult = { ok: unknown } | { err: EngineErr };

/// Asks `bot` to take `staging`'s open seat.
export type PlayBot = (bot: BotRef, staging: Staging) => Promise<PlayResult>;

/// The `PlayBot` over the bot canister's own `play(host, tableId, seat,
/// code, complexity)`, called with the player's `agent`.
export function botPlayer(agent: HttpAgent, backendId: string): PlayBot {
  const host = Principal.fromText(backendId);
  return (bot, s) => {
    const actor = Actor.createActor(buildBotPlayIdlFactory as unknown as Parameters<typeof Actor.createActor>[0], {
      agent,
      canisterId: bot.principal,
    });
    return actor.play(host, s.tableId, s.openSeat, s.code, bot.complexity) as Promise<PlayResult>;
  };
}

/// The `BotRef` a clicked Challenge button (or anything inside one) carries.
export function botRefOf(target: unknown): BotRef | null {
  const el = (target as { closest?: (sel: string) => { dataset: Record<string, string> } | null }).closest?.(
    "[data-challenge-bot]",
  );
  if (!el) return null;
  const principal = el.dataset.challengeBot;
  return { principal, name: el.dataset.botName || principal, complexity: el.dataset.botComplexity || "" };
}

export function stagingOf(status: Status | null): Staging | null {
  const at = atTableOf(status);
  const v = viewOf<StagingYouView>(status, "stagingYou");
  if (at === null || v === null) return null;
  return {
    tableId: at.id,
    openSeat: tag(v.seat) === "p1" ? { p2: null } : { p1: null },
    code: "code" in v.visibility ? [v.visibility.code] : [],
  };
}

/// What a failed `play` means to the player: the error is the bot's own.
export function botErrText(bot: BotRef, err: EngineErr): string {
  if ("tooManyTables" in err) {
    return `${botDisplayName(bot.name, bot.complexity)} is already playing ${err.tooManyTables.max} games — try again shortly.`;
  }
  return errText(err);
}

export interface BotInviterState {
  /// This session's own table waiting for an opponent, else `null`.
  staging: Staging | null;
  /// The bot being asked right now.
  inviting: BotRef | null;
  /// Why the last invite failed; cleared by the next one.
  error: string | null;
}

export interface BotInviter {
  getState(): BotInviterState;
  /// Called after every change. Returns the unsubscribe function.
  subscribe(listener: (state: BotInviterState) => void): () => void;
  /// Seats `bot` at this session's waiting table, or at a new one in
  /// `seat` (required then). Resolves `true` once the bot has joined.
  challenge(bot: BotRef, seat?: SeatTag): Promise<boolean>;
  dispose(): void;
}

export interface BotInviterOptions {
  client: DuelClient;
  play: PlayBot;
  /// A new table's `Options`; default `{}` (`mountBotChallenge`: the
  /// plugin's first `optionChoices()` entry).
  options?: unknown;
  /// Where the last seated bot is remembered across a reload; default
  /// `sessionStorage` (per tab, like an anonymous identity).
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  storageKey?: string;
}

type LastBot = BotRef & { tableId: bigint };

/// The headless bot invite: seats a bot through its `play`, and re-invites
/// the same bot when a Rematch stages its table reserved for it (nothing
/// else asks a bot to accept).
export function createBotInviter({
  client,
  play,
  options = {},
  storage = defaultStorage(),
  storageKey = "duel-last-bot",
}: BotInviterOptions): BotInviter {
  let state: BotInviterState = { staging: stagingOf(client.getState().status), inviting: null, error: null };
  const listeners = new Set<(s: BotInviterState) => void>();
  let lastBot = loadLastBot();
  let reinvited: string | null = null;

  function set(patch: Partial<BotInviterState>): void {
    state = { ...state, ...patch };
    for (const fn of listeners) fn(state);
  }

  function loadLastBot(): LastBot | null {
    try {
      const raw = storage?.getItem(storageKey);
      if (!raw) return null;
      const b = JSON.parse(raw);
      return { principal: b.principal, name: b.name, complexity: b.complexity, tableId: BigInt(b.tableId) };
    } catch {
      return null;
    }
  }

  function setLastBot(b: LastBot | null): void {
    lastBot = b;
    try {
      if (b === null) storage?.removeItem(storageKey);
      else storage?.setItem(storageKey, JSON.stringify({ ...b, tableId: b.tableId.toString() }));
    } catch {}
  }

  async function invite(bot: BotRef, staging: Staging): Promise<boolean> {
    set({ inviting: bot, error: null });
    try {
      const res = await play(bot, staging);
      if ("err" in res) {
        set({ inviting: null, error: botErrText(bot, res.err) });
        return false;
      }
      setLastBot({ ...bot, tableId: staging.tableId });
      set({ inviting: null });
      return true;
    } catch (e) {
      set({ inviting: null, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  async function challenge(bot: BotRef, seat?: SeatTag): Promise<boolean> {
    if (state.inviting !== null) return false;
    if (state.staging !== null) return invite(bot, state.staging);
    if (seat === undefined) {
      set({ error: "Choose a seat first." });
      return false;
    }
    set({ inviting: bot, error: null });
    const res = await client.createTable(seat, { open: null }, options);
    const staging = res.ok ? stagingOf(res.view) : null;
    if (staging === null) {
      set({ inviting: null, error: "message" in res ? res.message : "Could not open a table — try again." });
      return false;
    }
    return invite(bot, staging);
  }

  const unsubscribe = client.subscribe(({ status }) => {
    if (status === null) return;
    const staging = stagingOf(status);
    const at = atTableOf(status);
    if (lastBot !== null && at?.id !== lastBot.tableId) setLastBot(null);
    if (staging?.tableId !== state.staging?.tableId || staging?.code[0] !== state.staging?.code[0]) set({ staging });
    const v = viewOf<StagingYouView>(status, "stagingYou");
    if (lastBot === null || staging === null || v === null || !v.reservedForPartner) return;
    const key = `${staging.tableId}:${v.gen}`;
    if (reinvited === key || state.inviting !== null) return;
    reinvited = key;
    const { principal, name, complexity } = lastBot;
    void invite({ principal, name, complexity }, staging);
  });

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    challenge,
    dispose() {
      unsubscribe();
      listeners.clear();
    },
  };
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/// The plain queries the overlays read; `idl.js` declares both on every actor.
export interface BotsActor {
  list_bots(): Promise<BotInfo[]>;
  get_leaderboard(): Promise<LeaderboardEntry[]>;
}

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function required(id: string): HTMLElement {
  const el = byId(id);
  if (!el) throw new Error(`duel-game-core: no element with id "${id}"`);
  return el;
}

export interface BotChallengeOptions extends BotInviterOptions {
  actor: Pick<BotsActor, "list_bots">;
  plugin: GamePlugin;
  /// Element ids; each defaults to the key's own name in kebab case
  /// (`panel` → `bot-challenge-panel`), as in the examples' `index.html`.
  ids?: Partial<Record<"panel" | "body" | "back" | "addPanel" | "addTrigger", string>>;
}

export interface BotChallenge extends BotInviter {
  /// Shows the bot list.
  open(): void;
  /// Starts a challenge from outside the panel (a leaderboard row):
  /// fills this session's waiting table, or asks for a seat from the
  /// lobby; anywhere else, asks the player to leave their table first.
  pick(bot: BotRef): void;
}

/// The default "🤖 Bots" overlay over `createBotInviter`: an "Add Bot"
/// control shown only while this session waits at its own table, a bot
/// list, a seat choice for a new table, and the invite's progress and
/// errors. Returns the inviter with `open`/`pick` for other entry points.
export function mountBotChallenge(opts: BotChallengeOptions): BotChallenge {
  const { actor, plugin, ids = {} } = opts;
  const panel = required(ids.panel ?? "bot-challenge-panel");
  const body = required(ids.body ?? "bot-challenge-body");
  const back = byId(ids.back ?? "bot-challenge-back");
  const addPanel = byId(ids.addPanel ?? "bot-add-panel");
  const addTrigger = byId(ids.addTrigger ?? "bot-add-trigger");
  const inviter = createBotInviter({ ...opts, options: opts.options ?? plugin.optionChoices?.()[0]?.options ?? {} });
  let picked: BotRef | null = null;
  let wasInviting = false;

  function show(html: string): void {
    panel.hidden = false;
    body.innerHTML = html;
  }

  async function open(): Promise<void> {
    picked = null;
    show(`<p class="muted">Loading…</p>`);
    try {
      body.innerHTML = renderBotList(await actor.list_bots(), plugin);
    } catch (err) {
      body.innerHTML = `<p class="error">Could not load bots.</p>`;
      console.error(err);
    }
  }

  function pick(bot: BotRef): void {
    if (inviter.getState().staging !== null) {
      void inviter.challenge(bot);
      return;
    }
    const { status } = opts.client.getState();
    if (status === null || !("browsing" in status)) {
      picked = null;
      show(`<p class="error">Leave your current table before challenging a bot.</p>`);
      return;
    }
    picked = bot;
    show(renderSeatChoice(plugin));
  }

  inviter.subscribe(({ staging, inviting, error }) => {
    if (addPanel) addPanel.hidden = staging === null;
    if (inviting !== null) show(`<p class="muted">Inviting ${esc(botDisplayName(inviting.name, inviting.complexity))}…</p>`);
    else if (error !== null && wasInviting) show(`<p class="error">${esc(error)}</p>`);
    else if (wasInviting) panel.hidden = true;
    wasInviting = inviting !== null;
  });
  if (addPanel) addPanel.hidden = inviter.getState().staging === null;

  body.addEventListener("click", (ev) => {
    const seatBtn = (ev.target as Element).closest?.("[data-challenge-seat]") as HTMLElement | null;
    if (seatBtn && picked !== null) {
      const bot = picked;
      picked = null;
      void inviter.challenge(bot, seatBtn.dataset.challengeSeat as SeatTag);
      return;
    }
    const bot = botRefOf(ev.target);
    if (bot) pick(bot);
  });
  addTrigger?.addEventListener("click", () => void open());
  back?.addEventListener("click", () => {
    picked = null;
    panel.hidden = true;
  });

  return { ...inviter, open: () => void open(), pick };
}

export interface LeaderboardOptions {
  actor: BotsActor | Pick<BotsActor, "get_leaderboard">;
  plugin: GamePlugin;
  /// Badges the caller's own row.
  sid: string;
  /// A bot row's Challenge button; without it the buttons do nothing.
  onChallenge?: (bot: BotRef) => void;
  ids?: Partial<Record<"toggle" | "panel" | "body" | "back", string>>;
}

/// The default 🏆 overlay: fetched on every open, hidden on Back or on a
/// bot row's Challenge.
export function mountLeaderboard({ actor, plugin, sid, onChallenge, ids = {} }: LeaderboardOptions): void {
  const toggle = required(ids.toggle ?? "leaderboard-toggle");
  const panel = required(ids.panel ?? "leaderboard-panel");
  const body = required(ids.body ?? "leaderboard-body");
  const back = byId(ids.back ?? "leaderboard-back");

  toggle.addEventListener("click", async () => {
    panel.hidden = false;
    body.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const listBots = "list_bots" in actor ? actor.list_bots().catch(() => [] as BotInfo[]) : Promise.resolve([]);
      const [entries, bots] = await Promise.all([actor.get_leaderboard(), listBots]);
      const botNames = new Map(bots.map((b) => [b.principal.toString(), b.name]));
      body.innerHTML = renderLeaderboard(entries, plugin, { yourSid: sid, botNames });
    } catch (err) {
      body.innerHTML = `<p class="error">Could not load the leaderboard.</p>`;
      console.error(err);
    }
  });
  back?.addEventListener("click", () => {
    panel.hidden = true;
  });
  body.addEventListener("click", (ev) => {
    const bot = botRefOf(ev.target);
    if (!bot || !onChallenge) return;
    panel.hidden = true;
    onChallenge(bot);
  });
}
