"use client";

/**
 * Rotate a PNG/JPEG blob around its centre on a white background.
 * Expands the canvas so nothing is clipped (needed for skewed scans).
 */
export async function rotateImageBlob(
  blob: Blob,
  degrees: number,
): Promise<Blob> {
  const d = ((degrees % 360) + 360) % 360;
  if (d === 0) return blob;

  const img = await createImageBitmap(blob);
  const rad = (d * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const w = Math.ceil(img.width * cos + img.height * sin);
  const h = Math.ceil(img.width * sin + img.height * cos);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2d context");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  img.close();

  const out = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!out) throw new Error("toBlob failed");
  return out;
}
