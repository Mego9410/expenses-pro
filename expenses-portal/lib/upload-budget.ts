/**
 * Vercel serverless requests are capped at ~4.5 MB total body size.
 * Keep a margin so multipart boundaries / metadata do not push us over.
 */
export const VERCEL_SAFE_UPLOAD_BYTES = 4_000_000;

async function blobToFitJpeg(
  blob: Blob,
  maxLongSide: number,
  quality: number,
): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  try {
    const w = bmp.width;
    const h = bmp.height;
    const scale = Math.min(1, maxLongSide / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get canvas context");
    ctx.drawImage(bmp, 0, 0, tw, th);
    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (!out) throw new Error("JPEG encode failed");
    return out;
  } finally {
    bmp.close();
  }
}

function totalBytes(blobs: Blob[]): number {
  return blobs.reduce((s, b) => s + b.size, 0);
}

async function blobsToJpegMaxDim(
  blobs: Blob[],
  maxLongSide: number,
  quality: number,
): Promise<Blob[]> {
  return Promise.all(
    blobs.map((b) => blobToFitJpeg(b, maxLongSide, quality)),
  );
}

/**
 * Re-encode page images so the multipart upload stays under Vercel's body limit.
 * Always recompresses from the original blobs (not chained JPEG recompression).
 */
export async function ensureUploadBlobsFitBudget(
  blobs: Blob[],
  maxTotalBytes = VERCEL_SAFE_UPLOAD_BYTES,
): Promise<Blob[]> {
  if (blobs.length === 0) return blobs;
  if (totalBytes(blobs) <= maxTotalBytes) return blobs;

  const steps: readonly (readonly [number, number])[] = [
    [2000, 0.88],
    [1600, 0.84],
    [1400, 0.8],
    [1200, 0.76],
    [1000, 0.72],
    [850, 0.68],
    [720, 0.64],
    [600, 0.6],
  ];

  for (const [maxDim, q] of steps) {
    const jpeg = await blobsToJpegMaxDim(blobs, maxDim, q);
    if (totalBytes(jpeg) <= maxTotalBytes) return jpeg;
  }

  const lastTry = await blobsToJpegMaxDim(blobs, 520, 0.55);
  if (totalBytes(lastTry) <= maxTotalBytes) return lastTry;

  throw new Error(
    `After compression, your pages are still ${(totalBytes(lastTry) / 1e6).toFixed(1)} MB. ` +
      `Vercel allows about 4 MB per request. Try a shorter statement, fewer pages, or run the app locally.`,
  );
}
