// The logged-in developer's chip in the topbar: avatar + display name,
// opening a small popover to rename (or log out).

import { useEffect, useRef, useState } from "react";
import type { Principal } from "@icp-sdk/core/principal";

import type { Err } from "../types";
import { errMessage } from "../types";

export function DisplayNameEditor({
  principal,
  displayName,
  loading,
  save,
  logout,
}: {
  principal: Principal | undefined;
  displayName: string | undefined;
  loading: boolean;
  save: (name: string) => Promise<void>;
  logout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="profile" ref={root}>
      <button
        type="button"
        className="profile-chip"
        onClick={() => {
          setDraft(displayName ?? "");
          setError(undefined);
          setOpen((o) => !o);
        }}
        aria-expanded={open}
      >
        <span className="avatar" style={avatarStyle(principal)} />
        {loading ? (
          <span className="unset">…</span>
        ) : displayName ? (
          <span>{displayName}</span>
        ) : (
          <span className="unset">Set display name</span>
        )}
      </button>
      {open && (
        <form
          className="profile-pop"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            setError(undefined);
            try {
              await save(draft);
              setOpen(false);
            } catch (err) {
              setError(errMessage(err as Err));
            } finally {
              setSaving(false);
            }
          }}
        >
          <label htmlFor="display-name">Display name</label>
          <input
            id="display-name"
            type="text"
            autoFocus
            value={draft}
            maxLength={40}
            placeholder="How players see you"
            onChange={(e) => setDraft(e.target.value)}
          />
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button
              type="button"
              className="btn ghost small"
              onClick={logout}
              disabled={saving}
            >
              Log out
            </button>
            <span style={{ flex: 1 }} />
            <button
              type="submit"
              className="btn primary small"
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/// A stable two-tone gradient derived from the principal, so every
/// developer gets a recognisable colour without uploading anything.
export function avatarStyle(
  principal: Principal | undefined
): React.CSSProperties | undefined {
  if (!principal) return undefined;
  let h = 0;
  for (const c of principal.toText()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = h % 360;
  const b = (a + 40 + ((h >> 8) % 80)) % 360;
  return {
    "--avatar": `linear-gradient(135deg, hsl(${a} 70% 60%), hsl(${b} 70% 35%))`,
  } as React.CSSProperties;
}
