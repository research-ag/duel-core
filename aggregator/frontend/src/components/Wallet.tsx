// The logged-in principal's cycle wallet (wallet.ts): its balance as a
// topbar chip, a dialog to send cycles to any canister (the canisters
// of the developer's own games one click away) and to add cycles from
// outside, and the send form the top-up page shares.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Principal } from "@icp-sdk/core/principal";

import {
  exactTC,
  formatTC,
  parseTC,
  refreshCycles,
  trackBackend,
  useCycleStore,
} from "../cycles";
import type { CycleStore } from "../cycles";
import { botsOf } from "../support";
import type { Bot } from "../support";
import type { GameView } from "../types";
import {
  LEDGER_FEE,
  isResend,
  refreshWallet,
  sendCycles,
  useWallet,
} from "../wallet";
import { CodeBlock, CopyId } from "./CodeBlock";
import { CyclesBadge } from "./CyclesBadge";
import { Bot as BotIcon, Search, Wallet as WalletIcon } from "./Icons";
import { Modal } from "./Modal";

export function WalletChip({ onOpen }: { onOpen: () => void }) {
  const wallet = useWallet();
  if (!wallet) return null;
  return (
    <button
      type="button"
      className="wallet-chip"
      onClick={onOpen}
      aria-label="Your cycle wallet"
      title="Your cycle wallet"
    >
      <WalletIcon />
      <span>{wallet.balance == null ? "…" : formatTC(wallet.balance)}</span>
    </button>
  );
}

const PRESETS = ["0.5", "1", "2"];

/// An amount in TC and a Send button for one canister, with the
/// ledger's answer underneath; `onSent` runs once the ledger has taken
/// the send, `delivered` unless it answered `Duplicate` (`SendResult`).
export function WalletSend({
  to,
  onSent,
}: {
  to: string;
  onSent?: (delivered: boolean) => void;
}) {
  const wallet = useWallet();
  const [preset, setPreset] = useState("1");
  const [custom, setCustom] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<
    { sent: string } | { taken: string } | { error: string } | undefined
  >(undefined);

  useEffect(() => setResult(undefined), [to]);

  if (!wallet) return null;
  const amount = parseTC(custom === "" ? preset : custom);
  const target = principalOf(to);
  const short =
    !(target && amount !== undefined && isResend(target, amount)) &&
    wallet.balance != null &&
    amount !== undefined &&
    wallet.balance < amount + LEDGER_FEE;
  const valid =
    amount !== undefined && amount > 0n && target !== undefined && !short;

  async function send() {
    if (!valid) return;
    setSending(true);
    setResult(undefined);
    try {
      const res = await sendCycles(target!, amount!);
      setResult(
        "sent" in res
          ? { sent: `Sent ${exactTC(amount!)} to ${to} (ledger block ${res.sent}).` }
          : {
              taken: `The ledger had already taken this send (block ${res.taken}) in the call that got no answer. If that delivery failed, the cycles came back to your wallet less 0.0002 TC in fees; ${to}'s balance shows whether they arrived.`,
            }
      );
      onSent?.("sent" in res);
    } catch (err) {
      setResult({ error: firstLine(err) });
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div className="amounts" role="group" aria-label="Amount">
        {PRESETS.map((v) => (
          <button
            key={v}
            type="button"
            className={`chip${preset === v && custom === "" ? " on" : ""}`}
            onClick={() => {
              setCustom("");
              setPreset(v);
            }}
          >
            {v} TC
          </button>
        ))}
        <label className="amount-custom">
          <input
            type="text"
            inputMode="decimal"
            value={custom}
            placeholder="other"
            onChange={(e) => setCustom(e.target.value)}
            aria-label="Custom amount in TC"
          />
          TC
        </label>
        <span className="note">
          {wallet.balance === undefined
            ? "reading your wallet…"
            : wallet.balance === null
              ? "your wallet could not be read"
              : `your wallet: ${formatTC(wallet.balance)}`}
        </span>
      </div>
      <div className="modal-actions">
        <span className="note">
          {short
            ? "More than your wallet holds with the 0.0001 TC fee."
            : "Plus a 0.0001 TC ledger fee. Cycles sent to a canister stay there."}
        </span>
        <button
          type="button"
          className="btn primary"
          disabled={!valid || sending}
          onClick={() => void send()}
        >
          {sending
            ? "Sending…"
            : `Send ${amount !== undefined && amount > 0n ? exactTC(amount) : "…"}`}
        </button>
      </div>
      {result && "sent" in result && <p className="sent">{result.sent}</p>}
      {result && "taken" in result && <p className="taken">{result.taken}</p>}
      {result && "error" in result && <p className="error">{result.error}</p>}
    </>
  );
}

/// The wallet dialog. `games` are every listing, offered as targets by
/// game in one list, the logged-in developer's first, searchable by a
/// game's name or any of its canisters' ids. A game's bots are asked
/// once its group scrolls into view, and every game's while a search
/// runs, since it may name a bot.
export function WalletModal({
  games,
  onClose,
}: {
  games: GameView[];
  onClose: () => void;
}) {
  const wallet = useWallet();
  const store = useCycleStore();
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const [bots, setBots] = useState<ReadonlyMap<string, Bot[]>>(new Map());
  const asked = useRef(new Set<string>());
  const q = query.trim().toLowerCase();
  const searching = q !== "";
  const backends = [
    ...new Set(
      games.flatMap(
        (g) => store.backends.get(g.frontendCanisterId.toText()) ?? []
      )
    ),
  ].join(" ");

  useEffect(() => {
    void refreshWallet();
  }, []);

  const askBots = useCallback((backend: string) => {
    if (asked.current.has(backend)) return;
    asked.current.add(backend);
    void botsOf(backend).then((list) => {
      if (!list?.length) return;
      for (const b of list) trackBackend(b.principal);
      setBots((m) => new Map(m).set(backend, list));
    });
  }, []);

  useEffect(() => {
    if (searching)
      for (const b of backends.split(" ").filter(Boolean)) askBots(b);
  }, [searching, backends, askBots]);

  if (!wallet) return null;
  const principal = wallet.principal.toText();
  const botsOfGroup = (g: Group) =>
    g.backend ? (bots.get(g.backend) ?? []) : [];
  const shown = (g: Group) =>
    !searching ||
    g.games.some(
      (x) =>
        x.title.toLowerCase().includes(q) ||
        x.frontendCanisterId.toText().includes(q)
    ) ||
    (g.backend?.includes(q) ?? false) ||
    botsOfGroup(g).some((b) => b.principal.includes(q));
  const mine = (g: GameView) => g.developer.toText() === principal;
  const sections: [string, Group[]][] = [
    ["My games", byBackend(games.filter(mine), store).filter(shown)],
    [
      "Other games",
      byBackend(
        games.filter((g) => !mine(g)),
        store
      ).filter(shown),
    ],
  ];

  return (
    <Modal onClose={onClose} className="info-modal wallet-modal">
      <div className="modal-kicker">Cycle wallet</div>
      <h2 className="modal-title">
        {wallet.balance === undefined
          ? "Reading…"
          : wallet.balance === null
            ? "Balance not readable"
            : formatTC(wallet.balance)}
      </h2>
      <p className="modal-intro">
        Cycles your login holds on the cycles ledger. Send them to any
        canister: a game's backend or frontend, or a bot.{" "}
        <button
          type="button"
          className="info-link"
          onClick={() => void refreshWallet()}
        >
          Refresh
        </button>
      </p>

      <h3 className="info-heading">Top up a canister</h3>
      {games.length > 0 && (
        <>
          <label className="search target-search">
            <Search />
            <input
              type="text"
              value={query}
              placeholder="Game name or canister id"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search games by name or canister id"
            />
          </label>
          <div className="target-list">
            {sections.every(([, groups]) => groups.length === 0) && (
              <p className="faint target-none">No game matches.</p>
            )}
            {sections.map(
              ([title, groups]) =>
                groups.length > 0 && (
                  <section key={title} aria-label={title}>
                    <h4 className="target-section">{title}</h4>
                    {groups.map((g) => (
                      <TargetGroup
                        key={g.key}
                        group={g}
                        bots={botsOfGroup(g)}
                        store={store}
                        to={to}
                        onPick={setTo}
                        onSeen={askBots}
                      />
                    ))}
                  </section>
                )
            )}
          </div>
        </>
      )}
      <div className="field">
        <input
          type="text"
          value={to}
          placeholder="Canister id"
          spellCheck={false}
          onChange={(e) => setTo(e.target.value.trim())}
          aria-label="Canister id"
        />
      </div>
      <WalletSend
        to={to}
        onSent={() => {
          if (store.readings.has(to)) void refreshCycles(to);
        }}
      />

      <details className="wallet-add">
        <summary className="info-heading">Add cycles</summary>
        <p className="faint">
          Send cycles on the cycles ledger (TCYCLES) to your principal: with
          icp-cli as below, or from any wallet that holds them. This principal
          belongs to your login on this address of the dashboard.
        </p>
        <dl className="info-rows">
          <dt>Principal</dt>
          <dd>
            <CopyId id={principal} />
          </dd>
        </dl>
        <CodeBlock code={`icp cycles transfer 1t ${principal} -e ic`} wrap />
      </details>
    </Modal>
  );
}

interface Group {
  key: string;
  backend: string | undefined;
  games: GameView[];
}

/// Listings sharing a backend, in listing order; one whose backend is
/// unknown (still looked up, or not published) stands alone.
function byBackend(games: GameView[], store: CycleStore): Group[] {
  const groups = new Map<string, Group>();
  for (const g of games) {
    const frontend = g.frontendCanisterId.toText();
    const backend = store.backends.get(frontend) ?? undefined;
    const key = backend ?? frontend;
    const group = groups.get(key);
    if (group) group.games.push(g);
    else groups.set(key, { key, backend, games: [g] });
  }
  return [...groups.values()];
}

/// One game's canisters: its backend, its listings' frontends, and its
/// bots; `onSeen` asks for those once the group scrolls into view.
function TargetGroup({
  group: { backend, games },
  bots,
  store,
  to,
  onPick,
  onSeen,
}: {
  group: Group;
  bots: Bot[];
  store: CycleStore;
  to: string;
  onPick: (id: string) => void;
  onSeen: (backend: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!backend || !el) return;
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      onSeen(backend);
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [backend, onSeen]);

  const title = [...new Set(games.map((g) => g.title))].join(" · ");
  const target = (id: string, content: ReactNode) => (
    <button
      key={id}
      type="button"
      className={`chip${to === id ? " on" : ""}`}
      onClick={() => onPick(id)}
    >
      {content}
    </button>
  );

  return (
    <div ref={ref} className="target-group" role="group" aria-label={title}>
      <div className="target-game">{title}</div>
      <div className="chips">
        {backend &&
          target(
            backend,
            <>
              Backend
              <CyclesBadge reading={store.readings.get(backend)} />
            </>
          )}
        {games.map((g) =>
          target(
            g.frontendCanisterId.toText(),
            games.length > 1 ? `${g.title} frontend` : "Frontend"
          )
        )}
        {bots.map((b) =>
          target(
            b.principal,
            <>
              <BotIcon />
              {b.name}
              <CyclesBadge reading={store.readings.get(b.principal)} of="Bot" />
            </>
          )
        )}
      </div>
    </div>
  );
}

function principalOf(text: string): Principal | undefined {
  try {
    return text ? Principal.fromText(text) : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}
