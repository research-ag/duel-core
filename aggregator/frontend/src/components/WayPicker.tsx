// The choice at the end of every guide's "How it works": which of the
// ways (cloudSession.ts's `Way`) the rest of the guide follows. The
// hosty.live set-up uses it again for where the agent runs.

import { ArrowRight } from "./Icons";

export interface WayOption<W extends string> {
  way: W;
  title: string;
  note: string;
}

export function WayPicker<W extends string>({
  options,
  picked,
  onPick,
}: {
  options: WayOption<W>[];
  picked: W | undefined;
  onPick: (way: W) => void;
}) {
  return (
    <div className="picker">
      {options.map((o) => (
        <button
          key={o.way}
          type="button"
          className={`pick${o.way === picked ? " on" : ""}`}
          onClick={() => onPick(o.way)}
        >
          <span className="pick-text">
            <span className="pick-title">{o.title}</span>
            <span className="pick-note">{o.note}</span>
          </span>
          <ArrowRight />
        </button>
      ))}
    </div>
  );
}
