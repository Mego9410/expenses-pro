"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import {
  AlertCircle,
  Check,
  Download,
  FileText,
  Loader2,
  Plus,
  RotateCcw,
  RotateCw,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { CATEGORIES, coerceCategory, type Category } from "@/lib/categories";
import {
  sortRowsForStatement,
  BUNDLED_TEMPLATE_DATA_ROWS,
  TEMPLATE_MAX_EXPENSE_ROWS,
} from "@/lib/statement-sort";
import { rotateImageBlob } from "@/lib/image-adjust";
import { rasterizePdfClient } from "@/lib/pdf-client";
import { cn, formatGBP } from "@/lib/utils";

type Row = {
  id: string;
  transaction_date: string;
  narrative: string;
  category: Category;
  gross: number;
};

type TaskState = "pending" | "running" | "done" | "error";
type Task = {
  id: string;
  label: string;
  state: TaskState;
  detail?: string;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function defaultMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return MONTHS[d.getMonth()];
}

function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === "AbortError") ||
    (e instanceof Error && e.name === "AbortError")
  );
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function fileFingerprint(f: File) {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

type PageAdjustState = {
  fileKey: string;
  baseBlobs: Blob[];
  /** Total rotation applied when sending to AI (degrees, clockwise). */
  rotationDeg: number[];
};

export default function Home() {
  const [name, setName] = useState("");
  const [month, setMonth] = useState(defaultMonth());
  const [card, setCard] = useState("");

  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<"idle" | "extracting" | "generating">(
    "idle",
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [extractedPages, setExtractedPages] = useState<number | null>(null);
  const [extractionSource, setExtractionSource] = useState<
    "python" | "vision" | null
  >(null);
  const [expectedTotal, setExpectedTotal] = useState<number | null>(null);
  const [pageAdjust, setPageAdjust] = useState<PageAdjustState | null>(null);
  const [straightenBusy, setStraightenBusy] = useState(false);
  const extractAbortRef = useRef<AbortController | null>(null);

  const onDrop = useCallback((accepted: File[]) => {
    setError(null);
    setRows([]);
    setTasks([]);
    setExtractedPages(null);
    setExtractionSource(null);
    setExpectedTotal(null);
    setPageAdjust(null);
    const f = accepted[0];
    if (f) setFile(f);
  }, []);

  function upsertTask(patch: Task) {
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === patch.id);
      if (idx === -1) return [...prev, patch];
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
    disabled: status !== "idle",
  });

  const total = useMemo(
    () => rows.reduce((sum, r) => sum + (Number.isFinite(r.gross) ? r.gross : 0), 0),
    [rows],
  );

  const previewUrls = useMemo(() => {
    if (!pageAdjust) return [];
    return pageAdjust.baseBlobs.map((b) => URL.createObjectURL(b));
  }, [pageAdjust]);

  useEffect(() => {
    return () => previewUrls.forEach((u) => URL.revokeObjectURL(u));
  }, [previewUrls]);

  function bumpRotation(pageIndex: number, delta: number) {
    setPageAdjust((prev) => {
      if (!prev) return prev;
      const rotationDeg = [...prev.rotationDeg];
      rotationDeg[pageIndex] = rotationDeg[pageIndex] + delta;
      return { ...prev, rotationDeg };
    });
  }

  function resetPageRotation(pageIndex: number) {
    setPageAdjust((prev) => {
      if (!prev) return prev;
      const rotationDeg = [...prev.rotationDeg];
      rotationDeg[pageIndex] = 0;
      return { ...prev, rotationDeg };
    });
  }

  async function handlePrepareStraighten() {
    if (!file || straightenBusy) return;
    setStraightenBusy(true);
    setError(null);
    try {
      const blobs = await rasterizePdfClient(file, {
        width: 2400,
        maxPages: 20,
      });
      setPageAdjust({
        fileKey: fileFingerprint(file),
        baseBlobs: blobs,
        rotationDeg: blobs.map(() => 0),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not render PDF pages");
    } finally {
      setStraightenBusy(false);
    }
  }

  function cancelExtract() {
    extractAbortRef.current?.abort();
  }

  async function handleExtract() {
    if (!file) return;
    const ac = new AbortController();
    extractAbortRef.current = ac;
    const signal = ac.signal;

    setStatus("extracting");
    setError(null);
    setRows([]);
    setTasks([]);
    setExtractedPages(null);
    setExtractionSource(null);
    setExpectedTotal(null);

    const renderTaskId = "render";
    upsertTask({
      id: renderTaskId,
      label: "Rendering PDF pages",
      state: "running",
    });

    try {
      const fp = fileFingerprint(file);
      const prepared =
        pageAdjust?.fileKey === fp && (pageAdjust?.baseBlobs.length ?? 0) > 0
          ? pageAdjust
          : null;

      let pages: Blob[];
      if (prepared) {
        upsertTask({
          id: renderTaskId,
          label: "Applying page rotations (from straighten step)",
          state: "running",
        });
        pages = [];
        for (let i = 0; i < prepared.baseBlobs.length; i++) {
          throwIfAborted(signal);
          pages.push(
            await rotateImageBlob(
              prepared.baseBlobs[i]!,
              prepared.rotationDeg[i] ?? 0,
            ),
          );
        }
        upsertTask({
          id: renderTaskId,
          label: `Prepared ${pages.length} page${pages.length === 1 ? "" : "s"} (with adjustments)`,
          state: "done",
        });
      } else {
        pages = await rasterizePdfClient(file, {
          width: 2400,
          maxPages: 20,
          signal,
          onProgress: ({ page, totalPages }) =>
            upsertTask({
              id: renderTaskId,
              label: `Rendering page ${page} of ${totalPages}`,
              state: "running",
            }),
        });
        upsertTask({
          id: renderTaskId,
          label: `Rendered ${pages.length} page${pages.length === 1 ? "" : "s"}`,
          state: "done",
        });
      }

      throwIfAborted(signal);

      const fd = new FormData();
      fd.append("pdf", file, file.name || "statement.pdf");
      pages.forEach((blob, idx) => {
        fd.append("images", blob, `page-${idx + 1}.png`);
      });

      const res = await fetch("/api/extract", {
        method: "POST",
        body: fd,
        signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        let msg = `HTTP ${res.status}`;
        try {
          const j = JSON.parse(text);
          if (j.error) msg = j.error;
        } catch {
          if (text) msg = text;
        }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        throwIfAborted(signal);
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line ("\n\n"). Some servers may
        // use "\r\n\r\n", so handle both.
        let sepIdx: number;
        while (
          (sepIdx = buffer.search(/\r?\n\r?\n/)) !== -1
        ) {
          const rawFrame = buffer.slice(0, sepIdx);
          // Advance past the separator (could be 2 or 4 chars).
          const match = buffer.slice(sepIdx).match(/^\r?\n\r?\n/);
          buffer = buffer.slice(sepIdx + (match ? match[0].length : 2));
          const lines = rawFrame.split(/\r?\n/);
          const dataLine = lines
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!dataLine) continue;
          let event: unknown;
          try {
            event = JSON.parse(dataLine);
          } catch {
            continue;
          }
          handleServerEvent(event);
        }
      }
    } catch (e) {
      if (isAbortError(e)) {
        setRows([]);
        setTasks([]);
        setExtractedPages(null);
        setExpectedTotal(null);
        setExtractionSource(null);
        return;
      }
      setError(e instanceof Error ? e.message : "Extraction failed");
      setTasks((prev) =>
        prev.map((t) =>
          t.state === "running" ? { ...t, state: "error" } : t,
        ),
      );
    } finally {
      extractAbortRef.current = null;
      setStatus("idle");
    }
  }

  function handleServerEvent(raw: unknown) {
    if (!raw || typeof raw !== "object") return;
    const event = raw as { type: string } & Record<string, unknown>;
    switch (event.type) {
      case "start": {
        const pageCount = Number(event.pageCount) || 0;
        if (event.extraction === "python") {
          upsertTask({
            id: "pdf-parser",
            label: "Extracting text from PDF (Python)",
            state: "running",
          });
        }
        for (let i = 1; i <= pageCount; i++) {
          upsertTask({
            id: `page-${i}`,
            label: `Reading page ${i} of ${pageCount}`,
            state: "pending",
          });
        }
        break;
      }
      case "page_start": {
        const page = Number(event.page);
        const total = Number(event.totalPages);
        upsertTask({
          id: `page-${page}`,
          label: `Reading page ${page} of ${total}`,
          state: "running",
        });
        break;
      }
      case "page_done": {
        const page = Number(event.page);
        const rowCount = Number(event.rowCount);
        upsertTask({
          id: `page-${page}`,
          label: `Page ${page} — ${rowCount} line${rowCount === 1 ? "" : "s"} found`,
          state: "done",
        });
        break;
      }
      case "page_error": {
        const page = Number(event.page);
        upsertTask({
          id: `page-${page}`,
          label: `Page ${page} — failed`,
          state: "error",
          detail:
            typeof event.message === "string" ? event.message : undefined,
        });
        break;
      }
      case "reconcile_start": {
        const attempt = Number(event.attempt);
        const max = Number(event.maxAttempts);
        const method =
          "method" in event && typeof event.method === "string"
            ? event.method
            : "";
        upsertTask({
          id: `reconcile-${attempt}`,
          label: method
            ? `Reconciling (${attempt}/${max}) — ${method}`
            : `Reconciling against statement total (attempt ${attempt}/${max})`,
          state: "running",
        });
        break;
      }
      case "reconcile_done": {
        const attempt = Number(event.attempt);
        const max = Number(event.maxAttempts);
        const matched = Boolean(event.matched);
        const sum = Number(event.sum);
        const expected =
          event.expectedTotal === null || event.expectedTotal === undefined
            ? null
            : Number(event.expectedTotal);
        if (matched && expected !== null) {
          upsertTask({
            id: `reconcile-${attempt}`,
            label: `Reconciled — matched ${formatGBP(expected)}`,
            state: "done",
          });
        } else if (expected !== null) {
          const diff = Math.abs(sum - expected);
          const lastAttempt = attempt >= max;
          upsertTask({
            id: `reconcile-${attempt}`,
            label: lastAttempt
              ? `Reconcile attempt ${attempt}/${max} — still off by ${formatGBP(diff)}`
              : `Off by ${formatGBP(diff)} — retrying`,
            state: lastAttempt ? "error" : "done",
          });
        } else {
          upsertTask({
            id: `reconcile-${attempt}`,
            label: `Reconcile attempt ${attempt}/${max} — no total found`,
            state: "error",
          });
        }
        break;
      }
      case "python_parse_done": {
        const n = Number(event.rowCount) || 0;
        upsertTask({
          id: "pdf-parser",
          label: `PDF parser — ${n} transaction line(s)`,
          state: "done",
        });
        break;
      }
      case "categorize_chunk": {
        const idx = Number(event.index) || 0;
        const total = Number(event.totalChunks) || 0;
        upsertTask({
          id: "categorize",
          label: `Categorising with AI (${idx}/${total})`,
          state: idx === total ? "done" : "running",
        });
        break;
      }
      case "complete": {
        const rowsIn = (event.rows as Record<string, unknown>[] | undefined) ?? [];
        const pageCount = Number(event.pageCount);
        const expected =
          event.expectedTotal === null || event.expectedTotal === undefined
            ? null
            : Number(event.expectedTotal);
        const mapped = rowsIn.map((r) => {
          const grossRaw = r.gross;
          const gross =
            typeof grossRaw === "number" && Number.isFinite(grossRaw)
              ? grossRaw
              : 0;
          return {
            id: uid(),
            transaction_date: String(r.transaction_date ?? ""),
            narrative: String(r.narrative ?? ""),
            category: coerceCategory(String(r.category ?? "")),
            gross,
          };
        });
        setRows(sortRowsForStatement(mapped));
        setExtractedPages(pageCount);
        setExtractionSource(
          event.extraction === "python"
            ? "python"
            : event.extraction === "vision"
              ? "vision"
              : null,
        );
        setExpectedTotal(expected);
        break;
      }
      case "error": {
        const message =
          typeof event.message === "string" ? event.message : "Server error";
        setError(message);
        setTasks((prev) =>
          prev.map((t) =>
            t.state === "running" ? { ...t, state: "error" } : t,
          ),
        );
        break;
      }
      default:
        break;
    }
  }

  async function handleGenerate() {
    if (rows.length === 0) return;
    if (rows.length > TEMPLATE_MAX_EXPENSE_ROWS) {
      setError(
        `Too many rows (${rows.length}). Maximum export is ${TEMPLATE_MAX_EXPENSE_ROWS} lines.`,
      );
      return;
    }
    setStatus("generating");
    setError(null);
    try {
      const payload = {
        meta: { name, month, card },
        rows: rows.map(({ narrative, category, gross }) => ({
          narrative: (narrative || "").trim() || "(no description)",
          category,
          gross: Number.isFinite(gross) && !Number.isNaN(gross) ? gross : 0,
        })),
      };
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const contentType = res.headers.get("Content-Type") ?? "";
      if (!res.ok) {
        if (contentType.includes("application/json")) {
          const j = (await res.json()) as { error?: string };
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      const blob = await res.blob();
      if (blob.size === 0) {
        throw new Error("Server returned an empty file. Check the dev console.");
      }
      const sig = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
      const isXlsxZip = sig[0] === 0x50 && sig[1] === 0x4b; // "PK" — xlsx is a zip
      if (!isXlsxZip) {
        const text = await blob.text();
        throw new Error(
          text.length < 400
            ? text || "Server did not return an Excel file."
            : "Server did not return an Excel file (got HTML or an error page). Check the terminal log.",
        );
      }
      const safeMonth = month.replace(/[/\\?%*:|"<>]/g, "-").trim() || "Month";
      const filename = `Card Expenses Form ${safeMonth}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      requestAnimationFrame(() => {
        a.click();
        setTimeout(() => {
          a.remove();
          URL.revokeObjectURL(url);
        }, 500);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generate failed");
    } finally {
      setStatus("idle");
    }
  }

  function updateRow(id: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function deleteRow(id: string) {
    setRows((rs) => rs.filter((r) => r.id !== id));
  }
  function addRow() {
    setRows((rs) => [
      ...rs,
      {
        id: uid(),
        transaction_date: "",
        narrative: "",
        category: "Subsistence",
        gross: 0,
      },
    ]);
  }

  return (
    <div className="bg-glow min-h-screen">
      <div className="bg-grid min-h-screen">
        <div className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
          <header className="mb-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-300">
              <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
              Powered by GPT-4o vision
            </div>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">
              Expenses Portal
            </h1>
            <p className="mt-3 max-w-xl text-neutral-400">
              Drop in this month&apos;s scanned receipts. The portal extracts
              each expense, categorises it, and gives you back a filled{" "}
              <span className="text-neutral-200">Card Expenses Form</span>{" "}
              spreadsheet.
            </p>
          </header>

          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm shadow-2xl shadow-black/40">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Name">
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="Month">
                <select
                  className="input"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                >
                  {MONTHS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Card">
                <input
                  className="input"
                  value={card}
                  onChange={(e) => setCard(e.target.value)}
                />
              </Field>
            </div>

            <div
              {...getRootProps()}
              className={cn(
                "mt-6 cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition",
                isDragActive
                  ? "border-indigo-400 bg-indigo-500/10"
                  : "border-white/15 hover:border-white/30 hover:bg-white/[0.02]",
                status !== "idle" && "cursor-not-allowed opacity-60",
              )}
            >
              <input {...getInputProps()} />
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-white/5">
                <Upload className="h-5 w-5 text-neutral-300" />
              </div>
              {file ? (
                <div className="mt-3">
                  <p className="text-sm font-medium text-neutral-100">
                    {file.name}
                  </p>
                  <p className="text-xs text-neutral-500">
                    {(file.size / 1024).toFixed(0)} KB &middot; ready to
                    extract
                  </p>
                </div>
              ) : (
                <div className="mt-3">
                  <p className="text-sm font-medium text-neutral-200">
                    Drop your scanned PDF here
                  </p>
                  <p className="text-xs text-neutral-500">
                    or click to browse &middot; one PDF, any number of pages
                  </p>
                </div>
              )}
            </div>

            {file && (
              <div className="mt-5 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={!file || status !== "idle" || straightenBusy}
                    onClick={handlePrepareStraighten}
                    className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-sm text-neutral-200 hover:bg-white/[0.08] disabled:opacity-50"
                  >
                    {straightenBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCw className="h-4 w-4 text-indigo-300" />
                    )}
                    Straighten / rotate pages
                  </button>
                  {pageAdjust &&
                    pageAdjust.fileKey === fileFingerprint(file) && (
                      <span className="text-xs text-emerald-400/90">
                        Extraction will use these adjusted images (not a fresh
                        render).
                      </span>
                    )}
                </div>

                {pageAdjust &&
                  pageAdjust.fileKey === fileFingerprint(file) && (
                    <div className="rounded-xl border border-white/10 bg-black/25 p-4">
                      <p className="mb-3 text-xs text-neutral-400">
                        If one page is skewed or sideways, fix it here before
                        running the AI. Use 90° for landscape pages; use ±1°/±2°
                        for a slight tilt.
                      </p>
                      <div className="flex gap-4 overflow-x-auto pb-2">
                        {pageAdjust.baseBlobs.map((_, i) => (
                          <div
                            key={i}
                            className="w-44 flex-shrink-0 rounded-lg border border-white/10 bg-white/[0.02] p-2"
                          >
                            <div className="flex h-52 items-center justify-center overflow-hidden rounded-md bg-neutral-900">
                              {previewUrls[i] ? (
                                <img
                                  src={previewUrls[i]}
                                  alt=""
                                  className="max-h-full max-w-full object-contain"
                                  style={{
                                    transform: `rotate(${pageAdjust.rotationDeg[i]}deg)`,
                                    transformOrigin: "center center",
                                  }}
                                />
                              ) : null}
                            </div>
                            <div className="mt-2 flex flex-wrap justify-center gap-1">
                              <button
                                type="button"
                                title="90° left"
                                className="rounded border border-white/10 p-1.5 hover:bg-white/10"
                                onClick={() => bumpRotation(i, -90)}
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                title="90° right"
                                className="rounded border border-white/10 p-1.5 hover:bg-white/10"
                                onClick={() => bumpRotation(i, 90)}
                              >
                                <RotateCw className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                className="rounded border border-white/10 px-1.5 py-1 text-[10px] hover:bg-white/10"
                                onClick={() => bumpRotation(i, -2)}
                              >
                                −2°
                              </button>
                              <button
                                type="button"
                                className="rounded border border-white/10 px-1.5 py-1 text-[10px] hover:bg-white/10"
                                onClick={() => bumpRotation(i, -1)}
                              >
                                −1°
                              </button>
                              <button
                                type="button"
                                className="rounded border border-white/10 px-1.5 py-1 text-[10px] hover:bg-white/10"
                                onClick={() => bumpRotation(i, 1)}
                              >
                                +1°
                              </button>
                              <button
                                type="button"
                                className="rounded border border-white/10 px-1.5 py-1 text-[10px] hover:bg-white/10"
                                onClick={() => bumpRotation(i, 2)}
                              >
                                +2°
                              </button>
                              <button
                                type="button"
                                className="rounded border border-white/10 px-1.5 py-1 text-[10px] text-neutral-400 hover:bg-white/10"
                                onClick={() => resetPageRotation(i)}
                              >
                                Reset
                              </button>
                            </div>
                            <p className="mt-1 text-center text-[10px] tabular-nums text-neutral-500">
                              Page {i + 1} · {pageAdjust.rotationDeg[i]}°
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <p className="mr-auto text-xs text-neutral-500">
                Your file is processed in-memory and never stored on disk.
              </p>
              {status === "extracting" && (
                <button
                  type="button"
                  onClick={cancelExtract}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/[0.06] px-3 py-2 text-sm text-neutral-200 hover:bg-white/[0.1]"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                disabled={!file || status !== "idle"}
                onClick={handleExtract}
                className="btn-primary"
              >
                {status === "extracting" ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Working...
                  </>
                ) : (
                  <>
                    <FileText className="h-4 w-4" />
                    Extract expenses
                  </>
                )}
              </button>
            </div>

            {tasks.length > 0 && (
              <div className="mt-5 rounded-xl border border-white/10 bg-black/20 px-4 py-3">
                <ul className="space-y-1.5">
                  {tasks.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-start gap-2.5 text-sm"
                    >
                      <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
                        {t.state === "running" && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" />
                        )}
                        {t.state === "done" && (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        )}
                        {t.state === "error" && (
                          <AlertCircle className="h-3.5 w-3.5 text-amber-400" />
                        )}
                        {t.state === "pending" && (
                          <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />
                        )}
                      </span>
                      <span
                        className={cn(
                          "leading-5",
                          t.state === "pending" && "text-neutral-500",
                          t.state === "running" && "text-neutral-100",
                          t.state === "done" && "text-neutral-300",
                          t.state === "error" && "text-amber-300",
                        )}
                      >
                        {t.label}
                        {t.detail && (
                          <span className="ml-2 text-xs text-neutral-500">
                            {t.detail}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {error && (
              <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}
          </section>

          {(rows.length > 0 || status === "generating") && (
            <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-6 shadow-2xl shadow-black/40">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold">Extracted expenses</h2>
                  <p className="text-sm text-neutral-400">
                    {extractedPages !== null &&
                      (extractionSource === "python"
                        ? `PDF text extraction — ${extractedPages} page${
                            extractedPages === 1 ? "" : "s"
                          } — `
                        : `Parsed ${extractedPages} page${
                            extractedPages === 1 ? "" : "s"
                          } — `)}
                    review and edit before generating. Rows are ordered by
                    statement date / position ({rows.length} lines; Excel export
                    grows past the default {BUNDLED_TEMPLATE_DATA_ROWS} rows, up
                    to {TEMPLATE_MAX_EXPENSE_ROWS}).
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-xs uppercase tracking-wide text-neutral-500">
                    Total
                  </div>
                  <div className="text-2xl font-semibold tabular-nums">
                    {formatGBP(total)}
                  </div>
                  {expectedTotal !== null && (
                    <div className="mt-1 text-xs text-neutral-500">
                      Statement total:{" "}
                      <span className="tabular-nums text-neutral-300">
                        {formatGBP(expectedTotal)}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {expectedTotal !== null &&
                Math.abs(total - expectedTotal) > 0.01 && (
                  <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                    <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
                    <div>
                      Doesn&apos;t match statement total of{" "}
                      <span className="font-semibold tabular-nums">
                        {formatGBP(expectedTotal)}
                      </span>{" "}
                      &mdash; off by{" "}
                      <span className="font-semibold tabular-nums">
                        {formatGBP(Math.abs(total - expectedTotal))}
                      </span>
                      . Review the rows below.
                    </div>
                  </div>
                )}

              <div className="mt-5 overflow-x-auto rounded-xl border border-white/10">
                <table className="min-w-full text-sm">
                  <thead className="bg-white/[0.04] text-left text-xs uppercase tracking-wide text-neutral-400">
                    <tr>
                      <th className="px-4 py-3 font-medium whitespace-nowrap">
                        Date
                      </th>
                      <th className="px-4 py-3 font-medium">Narrative</th>
                      <th className="px-4 py-3 font-medium">Category</th>
                      <th className="px-4 py-3 font-medium text-right">
                        Gross £
                      </th>
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {rows.map((r) => (
                      <tr key={r.id} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-2 w-36">
                          <input
                            className="input-cell text-xs"
                            placeholder="e.g. 20 Mar 2026"
                            value={r.transaction_date}
                            onChange={(e) =>
                              updateRow(r.id, {
                                transaction_date: e.target.value,
                              })
                            }
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            className="input-cell"
                            value={r.narrative}
                            onChange={(e) =>
                              updateRow(r.id, { narrative: e.target.value })
                            }
                          />
                        </td>
                        <td className="px-3 py-2">
                          <select
                            className="input-cell"
                            value={r.category}
                            onChange={(e) =>
                              updateRow(r.id, {
                                category: e.target.value as Category,
                              })
                            }
                          >
                            {CATEGORIES.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            step="0.01"
                            className="input-cell text-right tabular-nums"
                            value={r.gross}
                            onChange={(e) =>
                              updateRow(r.id, {
                                gross: parseFloat(e.target.value) || 0,
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            onClick={() => deleteRow(r.id)}
                            className="rounded-md p-1.5 text-neutral-500 hover:bg-white/5 hover:text-red-400"
                            title="Delete row"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={addRow}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-neutral-200 hover:bg-white/[0.06]"
                >
                  <Plus className="h-4 w-4" /> Add row
                </button>
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={status !== "idle" || rows.length === 0}
                  className="btn-primary"
                >
                  {status === "generating" ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Building spreadsheet...
                    </>
                  ) : (
                    <>
                      <Download className="h-4 w-4" />
                      Generate spreadsheet
                    </>
                  )}
                </button>
              </div>
            </section>
          )}

          <footer className="mt-12 text-center text-xs text-neutral-600">
            Built locally &middot; receipts and spreadsheets never leave your
            machine except for the OpenAI vision call.
          </footer>
        </div>
      </div>

      <style jsx global>{`
        .input {
          width: 100%;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 0.5rem;
          padding: 0.55rem 0.75rem;
          color: #f4f4f5;
          outline: none;
          transition: border-color 0.15s, background 0.15s;
        }
        .input:focus {
          border-color: rgba(129, 140, 248, 0.7);
          background: rgba(255, 255, 255, 0.06);
        }
        .input-cell {
          width: 100%;
          background: transparent;
          border: 1px solid transparent;
          border-radius: 0.375rem;
          padding: 0.4rem 0.55rem;
          color: #f4f4f5;
          outline: none;
        }
        .input-cell:focus {
          background: rgba(255, 255, 255, 0.04);
          border-color: rgba(129, 140, 248, 0.5);
        }
        /* After .input-cell so background wins. Native dropdown list is often light — options need dark text */
        select.input,
        select.input-cell {
          background-color: rgba(24, 24, 27, 0.95) !important;
          color: #f4f4f5;
        }
        select.input:focus,
        select.input-cell:focus {
          background-color: rgba(255, 255, 255, 0.06) !important;
        }
        select.input option,
        select.input-cell option {
          color: #18181b;
          background-color: #fafafa;
        }
        .btn-primary {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          background: linear-gradient(180deg, #6366f1, #4f46e5);
          color: white;
          font-weight: 500;
          font-size: 0.875rem;
          padding: 0.6rem 1rem;
          border-radius: 0.6rem;
          border: 1px solid rgba(255, 255, 255, 0.12);
          box-shadow: 0 8px 24px -8px rgba(79, 70, 229, 0.6);
          transition: filter 0.15s, transform 0.05s;
        }
        .btn-primary:hover:not(:disabled) {
          filter: brightness(1.08);
        }
        .btn-primary:active:not(:disabled) {
          transform: translateY(1px);
        }
        .btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs uppercase tracking-wide text-neutral-400">
        {label}
      </span>
      {children}
    </label>
  );
}
