"use client";

// Client-side PDF rasterization. Runs entirely in the browser using pdfjs's
// standard build (no Node bindings, no Turbopack interop pain).

type PdfModule = {
  getDocument: (params: unknown) => { promise: Promise<PdfDocument> };
  GlobalWorkerOptions: { workerSrc: string };
};

interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

interface PdfPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: unknown): { promise: Promise<void> };
  cleanup(): void;
}

let pdfjsPromise: Promise<PdfModule> | null = null;
function loadPdfjs(): Promise<PdfModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // Dynamic import keeps pdfjs out of the initial client bundle.
      const mod = (await import("pdfjs-dist")) as unknown as PdfModule;
      mod.GlobalWorkerOptions.workerSrc = "/pdfjs-worker.mjs";
      return mod;
    })();
  }
  return pdfjsPromise;
}

export interface RasterizeProgress {
  page: number;
  totalPages: number;
}

/**
 * Rasterize each page of a PDF file to a PNG Blob, in order.
 * Calls onProgress as each page completes.
 */
function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

export async function rasterizePdfClient(
  file: File,
  opts: {
    width?: number;
    maxPages?: number;
    onProgress?: (p: RasterizeProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<Blob[]> {
  const { width = 1600, maxPages = 20, onProgress, signal } = opts;
  const pdfjs = await loadPdfjs();
  throwIfAborted(signal);

  const buf = await file.arrayBuffer();
  throwIfAborted(signal);
  // Tell pdfjs where to fetch its wasm decoders (jbig2 in particular - your
  // scanner compresses receipt images with Jbig2; without this they render
  // as blank pages).
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    wasmUrl: "/pdfjs-wasm/",
  });
  const pdf = await loadingTask.promise;
  throwIfAborted(signal);

  const pages: Blob[] = [];
  const pageCount = Math.min(pdf.numPages, maxPages);

  try {
    for (let i = 1; i <= pageCount; i++) {
      throwIfAborted(signal);
      const page = await pdf.getPage(i);
    const viewportAt1 = page.getViewport({ scale: 1 });
    const scale = width / viewportAt1.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2d canvas context");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    throwIfAborted(signal);
    page.cleanup();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("canvas.toBlob returned null");
    pages.push(blob);

    onProgress?.({ page: i, totalPages: pageCount });
    }

    return pages;
  } finally {
    await pdf.destroy().catch(() => {});
  }
}
