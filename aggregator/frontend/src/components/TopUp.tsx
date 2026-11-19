// The top-up view of the info modal: the logged-in visitor's cycle
// wallet, an amount into a prefilled CyclePay checkout for anyone, the
// other routes for the game's developer, and a watch on `/metrics`
// afterwards so the arrival shows here.

import { useEffect, useState } from "react";

import {
  CYCLEPAY_MAX_USD,
  CYCLEPAY_MIN_USD,
  CYCLEPAY_NO_SIGN_IN_USD,
  STATUS_WORD,
  cycleExpressUrl,
  cyclePayUrl,
  cyclesOf,
  formatTC,
  hostyCanisterUrl,
  refreshCycles,
  statusOf,
  tcForUsd,
} from "../cycles";
import type { Reading } from "../cycles";
import { useWallet } from "../wallet";
import { CodeBlock } from "./CodeBlock";
import { WalletSend } from "./Wallet";

const PRESETS = [1, 2, 5, 10, 25];
const WATCH_EVERY_MS = 5_000;
const WATCH_FOR_MS = 120_000;

export function TopUp({
  backend,
  reading,
  isOwner,
}: {
  backend: string;
  reading: Reading;
  isOwner: boolean;
}) {
  const wallet = useWallet();
  const cycles = cyclesOf(reading);
  const status = statusOf(reading);
  const [usd, setUsd] = useState(2);
  const [custom, setCustom] = useState("");
  /// The balance before the payment: the one on screen when the payment
  /// started, or the fresh read started at that moment. Never a balance
  /// read later, which could already include the payment. `"frozen"`
  /// when the backend refused that read: any readable balance after it
  /// is the arrival.
  const [since, setSince] = useState<bigint | "frozen" | undefined>(
    undefined
  );
  const [watching, setWatching] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  /// No balance could be read before the payment, so its arrival cannot
  /// be confirmed here.
  const [unconfirmable, setUnconfirmable] = useState(false);

  const valid =
    Number.isInteger(usd) && usd >= CYCLEPAY_MIN_USD && usd <= CYCLEPAY_MAX_USD;

  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const tick = async () => {
      const now = await refreshCycles(backend);
      if (cancelled) return;
      const nowCycles = cyclesOf(now);
      if (since === undefined) {
        // The read started as the payment began: the baseline, or
        // nothing to compare against.
        if (nowCycles !== undefined) setSince(nowCycles);
        else if (now === "frozen") setSince("frozen");
        else {
          setWatching(false);
          setUnconfirmable(true);
        }
        return;
      }
      if (
        nowCycles !== undefined &&
        (since === "frozen" || nowCycles > since)
      ) {
        setWatching(false);
        return;
      }
      if (Date.now() - started >= WATCH_FOR_MS) {
        setWatching(false);
        setGaveUp(true);
        return;
      }
      timer = setTimeout(() => void tick(), WATCH_EVERY_MS);
    };
    timer = setTimeout(
      () => void tick(),
      since === undefined ? 0 : WATCH_EVERY_MS
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [watching, since, backend]);

  function startWatching() {
    setSince(cycles ?? (reading === "frozen" ? "frozen" : undefined));
    setGaveUp(false);
    setUnconfirmable(false);
    setWatching(true);
  }

  /// A delivered send needs no watch to be confirmed; one the ledger had
  /// taken in an unanswered call does. Either way the watch needs a
  /// balance from before the send.
  function sentFromWallet(delivered: boolean) {
    if (cycles !== undefined || reading === "frozen") startWatching();
    else {
      void refreshCycles(backend);
      if (!delivered) setUnconfirmable(true);
    }
  }

  const received =
    since !== undefined && cycles !== undefined
      ? since === "frozen"
        ? cycles
        : cycles > since
          ? cycles - since
          : undefined
      : undefined;

  return (
    <>
      <div className="modal-kicker">Top up</div>
      <h2 className="modal-title">Send cycles to this backend</h2>
      <p className="modal-intro">
        Cycles pay for the game's computation and storage. They go to the
        canister itself, from anyone, and are final once delivered.
      </p>
      <dl className="info-rows">
        <dt>Backend</dt>
        <dd className="mono">{backend}</dd>
        <dt>Balance</dt>
        <dd>
          {reading === undefined && <span className="faint">Reading…</span>}
          {reading === null && <span className="faint">Not readable</span>}
          {cycles !== undefined && formatTC(cycles)}
          {status !== undefined && status !== "healthy" && (
            <span className={`status ${status}`}>
              {cycles !== undefined && " · "}
              {STATUS_WORD[status]}
            </span>
          )}
          {received !== undefined && (
            <span className="received">
              {" "}
              {since === "frozen"
                ? "· cycles arrived, no longer frozen"
                : `+${formatTC(received)} received`}
            </span>
          )}
          {watching && received === undefined && (
            <span className="faint"> · waiting for cycles to arrive…</span>
          )}
          {unconfirmable && (
            <span className="faint">
              {" "}
              · its balance could not be read before the payment, so the
              arrival cannot be confirmed here.
            </span>
          )}
          {gaveUp && received === undefined && (
            <span className="faint">
              {" "}
              · nothing arrived in two minutes.{" "}
              <button
                type="button"
                className="info-link"
                onClick={startWatching}
              >
                Keep watching
              </button>
            </span>
          )}
        </dd>
      </dl>

      {wallet && (
        <>
          <h3 className="info-heading">From your wallet</h3>
          <WalletSend to={backend} onSent={sentFromWallet} />
        </>
      )}

      <h3 className="info-heading">Pay by card</h3>
      <div className="amounts" role="group" aria-label="Amount">
        {PRESETS.map((v) => (
          <button
            key={v}
            type="button"
            className={`chip${usd === v && custom === "" ? " on" : ""}`}
            onClick={() => {
              setCustom("");
              setUsd(v);
            }}
          >
            ${v}
          </button>
        ))}
        <label className="amount-custom">
          $
          <input
            type="number"
            min={CYCLEPAY_MIN_USD}
            max={CYCLEPAY_MAX_USD}
            step={1}
            placeholder="other"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              setUsd(Number(e.target.value));
            }}
            aria-label="Custom amount in dollars"
          />
        </label>
        <span className="note">
          {valid
            ? `about ${tcForUsd(usd).toFixed(2)} TC`
            : `whole dollars, ${CYCLEPAY_MIN_USD} to ${CYCLEPAY_MAX_USD}`}
        </span>
      </div>
      <div className="modal-actions">
        <span className="note">
          Opens CyclePay's Stripe checkout in a new tab; the TC figure is an
          estimate, the checkout states the charge.
          {valid &&
            usd < CYCLEPAY_NO_SIGN_IN_USD &&
            ` Sign-in needed under $${CYCLEPAY_NO_SIGN_IN_USD}.`}
        </span>
        <a
          className={`btn primary${valid ? "" : " disabled"}`}
          href={valid ? cyclePayUrl(backend, usd) : undefined}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!valid}
          onClick={(e) => {
            if (!valid) e.preventDefault();
            else startWatching();
          }}
        >
          Pay ${valid ? usd : "…"} through CyclePay
        </a>
      </div>

      <h3 className="info-heading">Other ways</h3>
      <ul className="info-list">
        <li>
          <a
            href={cycleExpressUrl(backend)}
            target="_blank"
            rel="noreferrer"
            onClick={startWatching}
          >
            Cycle Express
          </a>
          , by card as well, already addressed to this backend.
        </li>
        {isOwner && (
          <li>
            <a
              href={hostyCanisterUrl(backend)}
              target="_blank"
              rel="noreferrer"
              onClick={startWatching}
            >
              Its page on hosty.live
            </a>
            , from your hosty.live balance, if you created it there.
          </li>
        )}
      </ul>
      {isOwner && (
        <>
          <p className="faint small">
            Deployed with icp-cli? From the identity that controls it:
          </p>
          <CodeBlock
            code={`icp canister top-up ${backend} -e ic --amount 1t`}
            wrap
          />
        </>
      )}
    </>
  );
}
