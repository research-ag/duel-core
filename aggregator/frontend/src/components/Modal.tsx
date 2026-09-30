// The one modal shell every dialog on this page uses: a blurred backdrop
// that closes on click or Escape, a scroll-locked document, a close
// button in the corner. Children are the dialog's own content.

import { useEffect } from "react";
import type { ReactNode } from "react";

import { Close } from "./Icons";

export function Modal({
  onClose,
  className,
  children,
  closable = true,
}: {
  onClose: () => void;
  className?: string;
  children: ReactNode;
  /// False while a request is in flight, so a stray click can't dismiss
  /// a form mid-save.
  closable?: boolean;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closable) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, closable]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && closable) onClose();
      }}
    >
      <div
        className={`modal${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
      >
        {closable && (
          <button
            type="button"
            className="icon-btn modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <Close />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
