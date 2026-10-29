// The balance in TC behind a coloured dot, on a card and in the info
// modal. Nothing while the lookup runs or when the backend serves no
// `cycles_balance`.

import type { Cycles } from "../cycles";
import { BAND_WORD, bandOf, formatTC } from "../cycles";

export function CyclesBadge({ cycles }: { cycles: Cycles }) {
  if (cycles == null) return null;
  const band = bandOf(cycles);
  return (
    <span
      className={`cycles ${band}`}
      title={`Backend balance: ${formatTC(cycles)}. ${BAND_WORD[band]}.`}
    >
      <i aria-hidden="true" />
      {formatTC(cycles)}
    </span>
  );
}
