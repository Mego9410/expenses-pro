import { NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  categorizeExpenseRows,
  extractExpenses,
  extractExpensesFromOcr,
  type ExtractProgressEvent,
} from "@/lib/openai";
import { runStatementPython } from "@/lib/python-statement";
import { sortRowsForStatement } from "@/lib/statement-sort";

export const runtime = "nodejs";
export const maxDuration = 300;

type ServerEvent =
  | ExtractProgressEvent
  | {
      type: "start";
      pageCount: number;
      imageSizesKB: number[];
      extraction?: "python" | "vision" | "ocr";
    }
  | {
      type: "complete";
      rows: Awaited<ReturnType<typeof extractExpenses>>["rows"];
      pageCount: number;
      expectedTotal: number | null;
      extraction?: "python" | "vision" | "ocr";
    }
  | { type: "error"; message: string };

export async function POST(req: NextRequest) {
  const debug = req.nextUrl.searchParams.get("debug") === "1";

  let pngBuffers: Buffer[] = [];
  let pdfBuffer: Buffer | null = null;
  let ocrPages: string[] = [];
  try {
    const form = await req.formData();
    const entries = form.getAll("images");
    for (const e of entries) {
      if (!(e instanceof File)) continue;
      const buf = Buffer.from(await e.arrayBuffer());
      pngBuffers.push(buf);
    }
    const pdfField = form.get("pdf");
    if (pdfField instanceof File && pdfField.size > 0) {
      pdfBuffer = Buffer.from(await pdfField.arrayBuffer());
    }
    const ocrField = form.get("ocr_json");
    if (typeof ocrField === "string" && ocrField.length > 0) {
      try {
        const parsed = JSON.parse(ocrField) as unknown;
        if (Array.isArray(parsed)) {
          ocrPages = parsed.map((x) => String(x ?? ""));
        }
      } catch {
        ocrPages = [];
      }
    }
    while (ocrPages.length < pngBuffers.length) ocrPages.push("");
    if (ocrPages.length > pngBuffers.length) {
      ocrPages = ocrPages.slice(0, pngBuffers.length);
    }
  } catch (err) {
    return jsonError(
      err instanceof Error ? err.message : "Failed to read upload",
      400,
    );
  }

  if (pngBuffers.length === 0 && !pdfBuffer) {
    return jsonError(
      "Upload the PDF (field 'pdf') and/or page images (field 'images').",
      400,
    );
  }

  if (debug) {
    try {
      const dir = path.join(process.cwd(), "tmp-debug");
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const writes: Promise<void>[] = pngBuffers.map((buf, i) =>
        fs.writeFile(path.join(dir, `${stamp}-page-${i + 1}.png`), buf),
      );
      if (pdfBuffer) {
        writes.push(fs.writeFile(path.join(dir, `${stamp}.pdf`), pdfBuffer));
      }
      await Promise.all(writes);
      console.log(`[/api/extract] debug=1: wrote debug files to ${dir}`);
    } catch (err) {
      console.warn("[/api/extract] debug write failed:", err);
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ServerEvent) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // Stream may be closed; ignore.
        }
      };

      // Send a padding comment to push past any proxy/Next buffering threshold
      // (some intermediaries buffer until ~2KB before flushing).
      controller.enqueue(encoder.encode(`: ${"keepalive ".repeat(200)}\n\n`));

      // Heartbeat every 5s so any intermediate buffer keeps flushing.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          // closed
        }
      }, 5000);

      // Run the work asynchronously so start() returns immediately and the
      // Response can begin streaming.
      (async () => {
        try {
          let pyResult = null as Awaited<
            ReturnType<typeof runStatementPython>
          > | null;
          if (pdfBuffer) {
            pyResult = await runStatementPython(pdfBuffer);
          }

          const usePython =
            pyResult !== null &&
            pyResult.rows.length > 0 &&
            pyResult.source !== "error";

          const ocrCharTotal = ocrPages.join("").length;
          const useOcr =
            !usePython &&
            pngBuffers.length > 0 &&
            ocrCharTotal >= 120 &&
            ocrPages.some((t) => t.trim().length > 40);

          if (!usePython && pngBuffers.length === 0) {
            send({
              type: "error",
              message:
                "This PDF has no extractable text layer (likely a scan). Re-render pages client-side or install Python + pymupdf for text PDFs.",
            });
            return;
          }

          send({
            type: "start",
            pageCount: usePython ? 0 : pngBuffers.length,
            imageSizesKB: pngBuffers.map((b) => Math.round(b.length / 1024)),
            extraction: usePython ? "python" : useOcr ? "ocr" : "vision",
          });

          if (usePython && pyResult) {
            const deduped = dedupeParsedRows(pyResult.rows);
            send({
              type: "python_parse_done",
              rowCount: deduped.length,
              expectedTotal: pyResult.expected_total ?? null,
              pageCount: pyResult.page_count ?? null,
            });
            let rows = await categorizeExpenseRows(deduped, (e) => send(e));
            rows = sortRowsForStatement(rows).map((r, i) => ({
              ...r,
              statement_index: i + 1,
            }));
            send({
              type: "complete",
              rows,
              pageCount: pyResult.page_count ?? 0,
              expectedTotal: pyResult.expected_total ?? null,
              extraction: "python",
            });
            return;
          }

          if (useOcr) {
            let { rows, expectedTotal } = await extractExpensesFromOcr(
              ocrPages,
              pngBuffers,
              (e) => send(e),
            );
            if (rows.length === 0) {
              ({ rows, expectedTotal } = await extractExpenses(
                pngBuffers,
                (e) => send(e),
              ));
              send({
                type: "complete",
                rows,
                pageCount: pngBuffers.length,
                expectedTotal,
                extraction: "vision",
              });
              return;
            }
            send({
              type: "complete",
              rows,
              pageCount: pngBuffers.length,
              expectedTotal,
              extraction: "ocr",
            });
            return;
          }

          const { rows, expectedTotal } = await extractExpenses(
            pngBuffers,
            (e) => send(e),
          );
          send({
            type: "complete",
            rows,
            pageCount: pngBuffers.length,
            expectedTotal,
            extraction: "vision",
          });
        } catch (err) {
          console.error("[/api/extract]", err);
          send({
            type: "error",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        } finally {
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function dedupeParsedRows(
  rows: { transaction_date: string; narrative: string; gross: number }[],
) {
  const seen = new Set<string>();
  const out: typeof rows = [];
  for (const r of rows) {
    const key = `${r.transaction_date}|${r.narrative.trim().toLowerCase()}|${Number(r.gross).toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
