import { Fragment, useEffect, useRef, useState } from "react";
import { Principal } from "@icp-sdk/core/principal";

import { invalidateBanner, useBanner } from "../hooks/useBanner";
import type {
  AggregatorActor,
  BannerRequirements,
  Err,
  GameView,
} from "../types";
import { errMessage, maybeToOpt, optToMaybe } from "../types";
import { Image } from "./Icons";
import { ImageCropper } from "./ImageCropper";
import { Modal } from "./Modal";

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
  const [frontendCanisterId, setFrontendCanisterId] = useState(
    existing?.frontendCanisterId.toText() ?? ""
  );
  const [customDomain, setCustomDomain] = useState(
    existing ? (optToMaybe(existing.customDomain) ?? "") : ""
  );
  const [bannerFile, setBannerFile] = useState<File | undefined>(undefined);
  const [bannerPreview, setBannerPreview] = useState<string | undefined>(
    undefined
  );
  const [cropSrc, setCropSrc] = useState<string | undefined>(undefined);
  const [requirements, setRequirements] = useState<
    BannerRequirements | undefined
  >(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [over, setOver] = useState(false);
  const existingBannerUrl = useBanner(actor, existing?.frontendCanisterId);
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

    let frontendId: Principal;
    try {
      frontendId = Principal.fromText(frontendCanisterId.trim());
    } catch {
      setError("Frontend canister id must be a valid principal.");
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
        const res = await actor.updateGame(existing.frontendCanisterId, {
          title,
          description,
          frontendCanisterId: frontendId,
          customDomain: maybeToOpt(domain || undefined),
          banner: maybeToOpt(bannerBytes),
        });
        if ("err" in res) throw res.err;
        if (bannerBytes) invalidateBanner(existing.frontendCanisterId);
      } else {
        const res = await actor.registerGame({
          title,
          description,
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

  const preview = bannerPreview ?? existingBannerUrl;

  return (
    <Fragment>
      <Modal onClose={onClose} closable={!saving} className="form-modal">
        <div className="modal-kicker">
          {isEdit ? "Edit listing" : "New listing"}
        </div>
        <h2 className="modal-title">
          {isEdit ? existing.title : "Register a game"}
        </h2>
        <p className="modal-intro">
          {isEdit
            ? "Update how this game appears in the registry."
            : "List a deployed duel-game-core game so players can find it here."}
        </p>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="field">
            <label htmlFor="banner">
              Banner
              {requirements && (
                <span className="opt">
                  {`${requirements.width}×${requirements.height}, PNG, up to ${Math.round(Number(requirements.maxBytes) / 1024)} KB — any image is cropped to fit`}
                </span>
              )}
            </label>
            <div
              className={`dropzone${preview ? " filled" : ""}${over ? " over" : ""}`}
              style={
                preview ? { backgroundImage: `url(${preview})` } : undefined
              }
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                pickFile(e.dataTransfer.files?.[0]);
              }}
            >
              <input
                ref={bannerInputRef}
                id="banner"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => pickFile(e.target.files?.[0])}
                disabled={!requirements}
                aria-label="Choose banner image"
              />
              <span className="prompt">
                {!preview && <Image />}
                <b>
                  {preview
                    ? "Choose a different image"
                    : "Drop an image or click to choose"}
                </b>
                {!preview && <span>You'll crop it to a 2:1 banner next.</span>}
              </span>
            </div>
          </div>

          <div className="field">
            <label htmlFor="title">Title</label>
            <input
              id="title"
              type="text"
              maxLength={60}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              placeholder="What players will see"
            />
          </div>

          <div className="field">
            <label htmlFor="description">
              Description<span className="opt">optional</span>
            </label>
            <textarea
              id="description"
              rows={3}
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A sentence or two about the game."
            />
          </div>

          <div className="field">
            <label htmlFor="frontend">Frontend canister</label>
            <input
              id="frontend"
              type="text"
              value={frontendCanisterId}
              onChange={(e) => setFrontendCanisterId(e.target.value)}
              required
              placeholder="rno2w-sqaaa-aaaaa-aaacq-cai"
            />
          </div>

          <div className="field">
            <label htmlFor="domain">
              Custom domain<span className="opt">optional</span>
            </label>
            <input
              id="domain"
              type="url"
              value={customDomain}
              onChange={(e) => setCustomDomain(e.target.value)}
              placeholder="https://mygame.example.com"
            />
            <span className="hint">
              Leave blank to link to
              https://&lt;frontend-canister-id&gt;.icp.net
            </span>
          </div>

          {error && <p className="error">{error}</p>}

          <div className="modal-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? "Saving…" : isEdit ? "Save changes" : "Register game"}
            </button>
          </div>
        </form>
      </Modal>

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
