// The two-pane step-by-step shell every guide is built on: a rail of
// numbered steps on the left (a row of numbers on narrow screens), the
// current step's content on the right, Back/Next below. The last step's
// primary action is the caller's. Steps past `reachable` are locked
// (the game-picking guides lock everything until a game is picked).

import { useState } from "react";
import type { ReactNode } from "react";

import { ArrowRight } from "./Icons";
import { Modal } from "./Modal";

export function Wizard({
  kicker,
  title,
  steps,
  render,
  onClose,
  finish,
  initialStep = 0,
  reachable = steps.length - 1,
}: {
  kicker: string;
  title: string;
  steps: readonly string[];
  render: (step: number, next: () => void) => ReactNode;
  onClose: () => void;
  /// The primary button on the last step.
  finish: { label: string; onClick: () => void; disabled?: boolean };
  initialStep?: number;
  reachable?: number;
}) {
  const [step, setStep] = useState(initialStep);
  const last = step === steps.length - 1;
  const next = () => setStep((s) => s + 1);

  return (
    <Modal onClose={onClose} className="wizard">
      <aside className="wizard-rail">
        <div className="modal-kicker">{kicker}</div>
        <h2>{title}</h2>
        {steps.map((s, i) => (
          <button
            key={s}
            type="button"
            className={`step-btn${i === step ? " on" : i < step ? " done" : ""}`}
            onClick={() => setStep(i)}
            disabled={i > reachable}
          >
            <span className="n">{i + 1}</span>
            <span className="t">{s}</span>
          </button>
        ))}
      </aside>
      <div className="wizard-main">
        <div className="wizard-body">
          <h3>{steps[step]}</h3>
          {render(step, next)}
        </div>
        <div className="wizard-progress">
          <i style={{ width: `${((step + 1) / steps.length) * 100}%` }} />
        </div>
        <div className="wizard-foot">
          <span style={{ color: "var(--muted)", fontSize: "0.82rem" }}>
            Step {step + 1} of {steps.length}
          </span>
          <span className="spacer" style={{ flex: 1 }} />
          {step > 0 && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => setStep((s) => s - 1)}
            >
              Back
            </button>
          )}
          {!last ? (
            <button
              type="button"
              className="btn primary"
              onClick={next}
              disabled={step >= reachable}
            >
              Next <ArrowRight />
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              onClick={finish.onClick}
              disabled={finish.disabled}
            >
              {finish.label} <ArrowRight />
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
