import { useState } from "react";

import type { Err } from "../types";
import { errMessage } from "../types";

export function DisplayNameEditor({
  displayName,
  loading,
  save,
}: {
  displayName: string | undefined;
  loading: boolean;
  save: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  if (loading) return <span className="name">…</span>;

  if (editing) {
    return (
      <form
        className="identity"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(undefined);
          try {
            await save(draft);
            setEditing(false);
          } catch (err) {
            setError(errMessage(err as Err));
          } finally {
            setSaving(false);
          }
        }}
      >
        <input
          type="text"
          autoFocus
          value={draft}
          maxLength={40}
          placeholder="Display name"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="primary" disabled={saving}>
          Save
        </button>
        <button type="button" onClick={() => setEditing(false)} disabled={saving}>
          Cancel
        </button>
        {error && <span className="error">{error}</span>}
      </form>
    );
  }

  return (
    <button
      onClick={() => {
        setDraft(displayName ?? "");
        setEditing(true);
      }}
    >
      {displayName ?? "Set display name"}
    </button>
  );
}
