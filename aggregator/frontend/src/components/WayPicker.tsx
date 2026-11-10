// The choice at the end of every guide's "How it works": which of the
// ways (cloudSession.ts's `Way`) the rest of the guide follows.

import type { Way } from "../cloudSession";
import { ArrowRight } from "./Icons";

export interface WayOption {
  way: Way;
  title: string;
  note: string;
}

export function WayPicker({
  options,
  picked,
  onPick,
}: {
  options: WayOption[];
  picked: Way | undefined;
  onPick: (way: Way) => void;
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
