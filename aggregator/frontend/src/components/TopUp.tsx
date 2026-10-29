// The top-up view of the info modal: an amount, a prefilled CyclePay
// checkout for anyone, the other routes for the game's developer, and
// a watch on `/metrics` afterwards so the arrival shows here.

import { useEffect, useState } from "react";

import {
  CYCLE_EXPRESS_URL,
  CYCLEPAY_MAX_USD,
  CYCLEPAY_MIN_USD,
  cyclePayUrl,
  formatTC,
  hostyCanisterUrl,
  refreshCycles,
  tcForUsd,
} from "../cycles";
import type { Cycles } from "../cycles";
import { CodeBlock } from "./CodeBlock";

const PRESETS = [5, 10, 25];
const WATCH_EVERY_MS = 5_000;
const WATCH_FOR_MS = 120_000;

export function TopUp({
  backend,
  cycles,
  isOwner,
}: {
  backend: string;
  cycles: Cycles;
  isOwner: boolean;
}) {
  const [usd, setUsd] = useState(10);
  const [custom, setCustom] = useState("");
  /// The balance before the payment: the one on screen when the payment
  /// page opened, or the fresh read started at that moment. Never a
  /// balance read later, which could already include the payment.
  const [since, setSince] = useState<bigint | undefined>(undefined);
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
      if (since === undefined) {
        // The read started as the payment page opened: the baseline, or
        // nothing to compare against.
        if (now != null) setSince(now);
        else {
          setWatching(false);
          setUnconfirmable(true);
        }
        return;
      }
      if (now != null && now > since) {
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
    setSince(cycles ?? undefined);
    setGaveUp(false);
    setUnconfirmable(false);
    setWatching(true);
  }

  const received =
    since !== undefined && cycles != null && cycles > since
      ? cycles - since
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
          {cycles === undefined && <span className="faint">Reading…</span>}
          {cycles === null && <span className="faint">Not readable</span>}
          {cycles != null && formatTC(cycles)}
          {received !== undefined && (
            <span className="received"> +{formatTC(received)} received</span>
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
            href={CYCLE_EXPRESS_URL}
            target="_blank"
            rel="noreferrer"
            onClick={startWatching}
          >
            Cycle Express
          </a>
          , pasting the backend id above as the recipient.
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
          />
        </>
      )}
    </>
  );
}
