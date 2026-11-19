// A canister's balance in TC behind a coloured dot, on a card, in the
// info modal and the wallet; "Frozen" for one that refuses even the
// read. Nothing while the lookup runs or when the canister serves no
// `cycles_balance`. `of` names the canister in the hover text.

import type { Reading } from "../cycles";
import { STATUS_WORD, formatTC, statusNote, statusOf } from "../cycles";

export function CyclesBadge({
  reading,
  of = "Backend",
}: {
  reading: Reading;
  of?: string;
}) {
  const status = statusOf(reading);
  if (reading == null || status === undefined) return null;
  return (
    <span
      className={`cycles ${status}`}
      title={`${of} balance, ${STATUS_WORD[status].toLowerCase()}. ${statusNote(reading)}`}
    >
      <i aria-hidden="true" />
      {reading === "frozen" ? STATUS_WORD.frozen : formatTC(reading.cycles)}
    </span>
  );
}

/// The red label over a card's banner when its backend takes no moves.
export function DownLabel({ reading }: { reading: Reading }) {
  const status = statusOf(reading);
  if (status !== "down" && status !== "frozen") return null;
  return <span className="card-alert">{STATUS_WORD[status]}</span>;
}
