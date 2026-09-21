import { Fragment, useEffect, useRef, useState } from "react";
import { Principal } from "@icp-sdk/core/principal";

import { useBanner } from "../hooks/useBanner";
import type { AggregatorActor, BannerRequirements, Err, GameView } from "../types";
import { errMessage, maybeToOpt, optToMaybe } from "../types";
import { ImageCropper } from "./ImageCropper";

export function GameFormModal({
  actor,
  existing,
  onClose,
  onSaved,
}: {
  actor: AggregatorActor;
  /// Present when editing an already-registered game; absent when
  /// registering a new one.
  existing?: GameView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = existing !== undefined;

  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [backendCanisterId, setBackendCanisterId] = useState(existing?.backendCanisterId.toText() ?? "");
  const [frontendCanisterId, setFrontendCanisterId] = useState(existing?.frontendCanisterId.toText() ?? "");
  const [customDomain, setCustomDomain] = useState(existing ? (optToMaybe(existing.customDomain) ?? "") : "");
  const [bannerFile, setBannerFile] = useState<File | undefined>(undefined);
  const [bannerPreview, setBannerPreview] = useState<string | undefined>(undefined);
  const [cropSrc, setCropSrc] = useState<string | undefined>(undefined);
  const [requirements, setRequirements] = useState<BannerRequirements | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const existingBannerUrl = useBanner(actor, existing?.backendCanisterId);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void actor.getBannerRequirements().then(setRequirements);
  }, [actor]);

  useEffect(() => {
    if (!bannerFile) return;
    const url = URL.createObjectURL(bannerFile);
    setBannerPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [bannerFile]);

  function pickFile(file: File | undefined) {
    if (!file) return;
    setCropSrc(URL.createObjectURL(file));
  }

  function closeCropper() {
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(undefined);
    if (bannerInputRef.current) bannerInputRef.current.value = "";
  }

  function applyCrop(file: File) {
    setBannerFile(file);
    closeCropper();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);

    let backendId: Principal;
    let frontendId: Principal;
    try {
      backendId = Principal.fromText(backendCanisterId.trim());
      frontendId = Principal.fromText(frontendCanisterId.trim());
    } catch {
      setError("Backend and frontend canister ids must be valid principals.");
      return;
    }

    let bannerBytes: Uint8Array | undefined;
    if (bannerFile) {
      if (requirements && BigInt(bannerFile.size) > requirements.maxBytes) {
        setError(`Banner must be at most ${requirements.maxBytes} bytes.`);
        return;
      }
      bannerBytes = new Uint8Array(await bannerFile.arrayBuffer());
    } else if (!isEdit) {
      setError("A banner image is required.");
      return;
    }

    const domain = customDomain.trim();
    setSaving(true);
    try {
      if (isEdit) {
        const res = await actor.updateGame(existing.backendCanisterId, {
          title,
          description,
          frontendCanisterId: frontendId,
          customDomain: maybeToOpt(domain || undefined),
          banner: maybeToOpt(bannerBytes),
        });
        if ("err" in res) throw res.err;
      } else {
        const res = await actor.registerGame({
          title,
          description,
          backendCanisterId: backendId,
          frontendCanisterId: frontendId,
          customDomain: maybeToOpt(domain || undefined),
          banner: bannerBytes as Uint8Array,
        });
        if ("err" in res) throw res.err;
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(errMessage(err as Err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Fragment>
      <div className="modal-backdrop">
        <div className="modal">
          <h2>{isEdit ? "Edit game" : "Register a game"}</h2>
          <form onSubmit={(e) => void handleSubmit(e)}>
            <div className="field">
              <label htmlFor="title">Title</label>
              <input
                id="title"
                type="text"
                maxLength={60}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="description">Description</label>
              <textarea
                id="description"
                rows={3}
                maxLength={500}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="backend">Backend canister id</label>
              <input
                id="backend"
                type="text"
                value={backendCanisterId}
                onChange={(e) => setBackendCanisterId(e.target.value)}
                disabled={isEdit}
                required
                placeholder="e.g. ryjl3-tyaaa-aaaaa-aaaba-cai"
              />
              {isEdit && <span className="hint">The backend canister id can't be changed after registration.</span>}
            </div>

            <div className="field">
              <label htmlFor="frontend">Frontend canister id</label>
              <input
                id="frontend"
                type="text"
                value={frontendCanisterId}
                onChange={(e) => setFrontendCanisterId(e.target.value)}
                required
                placeholder="e.g. rno2w-sqaaa-aaaaa-aaacq-cai"
              />
            </div>

            <div className="field">
              <label htmlFor="domain">Custom domain (optional)</label>
              <input
                id="domain"
                type="url"
                value={customDomain}
                onChange={(e) => setCustomDomain(e.target.value)}
                placeholder="https://mygame.example.com"
              />
              <span className="hint">
                Leave blank to use https://&lt;frontend-canister-id&gt;.icp.net
              </span>
            </div>

            <div className="field">
              <label htmlFor="banner">
                Banner{" "}
                {requirements
                  ? `(PNG, exactly ${requirements.width}x${requirements.height}px, max ${Math.round(Number(requirements.maxBytes) / 1024)} KB)`
                  : "(PNG)"}
              </label>
              <input
                ref={bannerInputRef}
                id="banner"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => pickFile(e.target.files?.[0])}
                disabled={!requirements}
              />
              {(bannerPreview ?? existingBannerUrl) && (
                <span
                  className="banner-preview"
                  style={{ backgroundImage: `url(${bannerPreview ?? existingBannerUrl})` }}
                />
              )}
              {isEdit && <span className="hint">Leave empty to keep the current banner.</span>}
            </div>

            {error && <p className="error">{error}</p>}

            <div className="modal-actions">
              <button type="button" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={saving}>
                {saving ? "Saving…" : isEdit ? "Save changes" : "Register"}
              </button>
            </div>
          </form>
        </div>
      </div>

      {cropSrc && requirements && (
        <ImageCropper
          imageSrc={cropSrc}
          targetWidth={Number(requirements.width)}
          targetHeight={Number(requirements.height)}
          onCancel={closeCropper}
          onCropped={applyCrop}
        />
      )}
    </Fragment>
  );
}
