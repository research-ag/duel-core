// The logged-in principal's cycle wallet (wallet.ts): its balance as a
// topbar chip, a dialog to send cycles to any canister (the developer's
// own backends and frontends one click away) and to add cycles from
// outside, and the send form the top-up page shares.

import { useEffect, useState } from "react";
import { Principal } from "@icp-sdk/core/principal";

import {
  exactTC,
  formatTC,
  parseTC,
  refreshCycles,
  useCycleStore,
} from "../cycles";
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
import { Wallet as WalletIcon } from "./Icons";
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

/// The wallet dialog. `games` are the logged-in developer's listings,
/// offered as targets.
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

  useEffect(() => {
    void refreshWallet();
  }, []);

  if (!wallet) return null;
  const principal = wallet.principal.toText();
  const targets = new Map<string, { label: string; backend: boolean }>();
  for (const g of games) {
    const backend = store.backends.get(g.frontendCanisterId.toText());
    if (backend && !targets.has(backend))
      targets.set(backend, { label: `${g.title} backend`, backend: true });
    targets.set(g.frontendCanisterId.toText(), {
      label: `${g.title} frontend`,
      backend: false,
    });
  }

  return (
    <Modal onClose={onClose} className="info-modal">
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
      {targets.size > 0 && (
        <div className="chips targets" role="group" aria-label="Your canisters">
          {[...targets].map(([id, t]) => (
            <button
              key={id}
              type="button"
              className={`chip${to === id ? " on" : ""}`}
              onClick={() => setTo(id)}
            >
              {t.label}
              {t.backend && <CyclesBadge reading={store.readings.get(id)} />}
            </button>
          ))}
        </div>
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

      <h3 className="info-heading">Add cycles</h3>
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
      <CodeBlock code={`icp cycles transfer 1t ${principal} -e ic`} />
    </Modal>
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
