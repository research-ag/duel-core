// A crop-then-resize step between "pick a file" and "upload a banner":
// lets the developer select any rectangular area (aspect ratio locked to
// the registry's own banner shape) of whatever image they chose, then
// rasterizes exactly that area onto a canvas sized to the exact
// width/height Store.mo requires (see Store.mo's bannerRequirements()).
// Purely a frontend convenience — Main.mo/Store.mo still validate the
// resulting PNG's dimensions and size the same as before.

import { useCallback, useState } from "react";
import Cropper from "react-easy-crop";
import type { Area, Point } from "react-easy-crop";

import { Modal } from "./Modal";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load that image."));
    img.src = src;
  });
}

async function cropToFile(
  imageSrc: string,
  area: Area,
  targetWidth: number,
  targetHeight: number
): Promise<File> {
  const img = await loadImage(imageSrc);
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't render a canvas.");
  ctx.drawImage(
    img,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    targetWidth,
    targetHeight
  );
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png")
  );
  if (!blob) throw new Error("Could not export the cropped image.");
  return new File([blob], "banner.png", { type: "image/png" });
}

export function ImageCropper({
  imageSrc,
  targetWidth,
  targetHeight,
  onCancel,
  onCropped,
}: {
  imageSrc: string;
  targetWidth: number;
  targetHeight: number;
  onCancel: () => void;
  onCropped: (file: File) => void;
}) {
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const onCropComplete = useCallback(
    (_percentArea: Area, pixelArea: Area) => setArea(pixelArea),
    []
  );

  async function apply() {
    if (!area) return;
    setBusy(true);
    setError(undefined);
    try {
      onCropped(await cropToFile(imageSrc, area, targetWidth, targetHeight));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not crop that image."
      );
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onCancel} closable={!busy} className="cropper-modal">
      <div className="modal-kicker">Banner</div>
      <h2 className="modal-title">Crop to fit</h2>
      <p className="modal-intro">
        Drag to position, zoom to frame. The result is exported at exactly{" "}
        {targetWidth}×{targetHeight}.
      </p>
      <div className="cropper-area">
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          aspect={targetWidth / targetHeight}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onCropComplete}
        />
      </div>
      <div className="field" style={{ marginTop: "1rem" }}>
        <label htmlFor="crop-zoom">Zoom</label>
        <input
          id="crop-zoom"
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
        />
      </div>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button
          type="button"
          className="btn ghost"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => void apply()}
          disabled={busy || !area}
        >
          {busy ? "Cropping…" : "Use this crop"}
        </button>
      </div>
    </Modal>
  );
}
