"use client";

export type OcrPageProgress = {
  page: number;
  totalPages: number;
  /** 0–1 for current page recognition */
  progress01: number;
};

export function normalizeOcrText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Client-side OCR (Tesseract.js), similar in spirit to Adobe Acrobat
 * "Recognise Text" — one plain-text string per page, in order.
 */
export async function ocrStatementPages(
  blobs: Blob[],
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: OcrPageProgress) => void;
  } = {},
): Promise<string[]> {
  const { signal, onProgress } = opts;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  };

  throwIfAborted();
  const { createWorker, PSM } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: "1",
      user_defined_dpi: "280",
    });

    const out: string[] = [];
    const n = blobs.length;
    for (let i = 0; i < n; i++) {
      throwIfAborted();
      const { data } = await worker.recognize(blobs[i]!);
      out.push(normalizeOcrText(data.text ?? ""));
      onProgress?.({
        page: i + 1,
        totalPages: n,
        progress01: 1,
      });
    }
    return out;
  } finally {
    await worker.terminate().catch(() => {});
  }
}
