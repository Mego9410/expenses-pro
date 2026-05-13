/**
 * Client-side extraction / reconciliation telemetry for tuning prompts
 * and heuristics. Used only on localhost in the UI.
 */

export type ReconcileAttemptLog = {
  attempt: number;
  maxAttempts: number;
  method: string;
  sum: number;
  expectedTotal: number | null;
  matched: boolean;
  /** |sum - expected| when expected is set */
  gapGbp: number | null;
};

export type ConsistencyReport = {
  startedAtIso: string;
  client?: {
    fileName?: string;
    ocrTextCharsApprox?: number;
    uploadPayloadKb?: number;
  };
  server: {
    extraction?: "python" | "vision" | "ocr";
    pageCount?: number;
    imageSizesKB?: number[];
    dedupe?: { rowCount: number; sum: number };
    perPage: { page: number; rowCount: number }[];
    reconcile: ReconcileAttemptLog[];
    final?: {
      rowCount: number;
      sumGbp: number;
      expectedTotalGbp: number | null;
      reconciled: boolean;
    };
  };
};

export function createFreshReport(
  client?: ConsistencyReport["client"],
): ConsistencyReport {
  return {
    startedAtIso: new Date().toISOString(),
    client: client ? { ...client } : undefined,
    server: { perPage: [], reconcile: [] },
  };
}

export function mergeServerEvent(
  report: ConsistencyReport,
  event: Record<string, unknown>,
): ConsistencyReport {
  const next: ConsistencyReport = {
    ...report,
    client: report.client ? { ...report.client } : undefined,
    server: {
      ...report.server,
      perPage: [...report.server.perPage],
      reconcile: [...report.server.reconcile],
    },
  };

  switch (event.type) {
    case "start": {
      const pageCount = Number(event.pageCount) || 0;
      const imageSizesKB = Array.isArray(event.imageSizesKB)
        ? event.imageSizesKB.map((x) => Number(x) || 0)
        : undefined;
      const extraction = event.extraction as ConsistencyReport["server"]["extraction"];
      next.server = {
        ...next.server,
        pageCount,
        imageSizesKB,
        extraction:
          extraction === "python" ||
          extraction === "vision" ||
          extraction === "ocr"
            ? extraction
            : next.server.extraction,
      };
      break;
    }
    case "page_done": {
      const page = Number(event.page) || 0;
      const rowCount = Number(event.rowCount) || 0;
      next.server.perPage = next.server.perPage.filter((p) => p.page !== page);
      next.server.perPage.push({ page, rowCount });
      next.server.perPage.sort((a, b) => a.page - b.page);
      break;
    }
    case "dedupe_done": {
      next.server.dedupe = {
        rowCount: Number(event.rowCount) || 0,
        sum: Number(event.sum) || 0,
      };
      break;
    }
    case "reconcile_done": {
      const attempt = Number(event.attempt) || 0;
      const maxAttempts = Number(event.maxAttempts) || 0;
      const method =
        typeof event.method === "string"
          ? event.method
          : next.server.reconcile.find((r) => r.attempt === attempt)?.method ??
            "";
      const sum = Number(event.sum) || 0;
      const expectedTotal =
        event.expectedTotal === null || event.expectedTotal === undefined
          ? null
          : Number(event.expectedTotal);
      const matched = Boolean(event.matched);
      const gapGbp =
        expectedTotal !== null && Number.isFinite(expectedTotal)
          ? Math.abs(sum - expectedTotal)
          : null;
      const rest = next.server.reconcile.filter((r) => r.attempt !== attempt);
      rest.push({
        attempt,
        maxAttempts,
        method,
        sum,
        expectedTotal,
        matched,
        gapGbp,
      });
      rest.sort((a, b) => a.attempt - b.attempt);
      next.server.reconcile = rest;
      break;
    }
    case "complete": {
      const rowsIn = (event.rows as { gross?: unknown }[] | undefined) ?? [];
      const sumGbp = rowsIn.reduce((s, r) => {
        const g =
          typeof r.gross === "number" && Number.isFinite(r.gross) ? r.gross : 0;
        return s + g;
      }, 0);
      const expectedTotalGbp =
        event.expectedTotal === null || event.expectedTotal === undefined
          ? null
          : Number(event.expectedTotal);
      const reconciled =
        expectedTotalGbp !== null &&
        Number.isFinite(expectedTotalGbp) &&
        Math.abs(sumGbp - expectedTotalGbp) <= 0.01;
      next.server.final = {
        rowCount: rowsIn.length,
        sumGbp,
        expectedTotalGbp,
        reconciled,
      };
      break;
    }
    default:
      break;
  }

  return next;
}

function heuristicNotes(r: ConsistencyReport): string[] {
  const notes: string[] = [];
  const fin = r.server.final;
  const ded = r.server.dedupe;
  const lastRec = r.server.reconcile[r.server.reconcile.length - 1];

  if (r.server.extraction === "ocr") {
    notes.push(
      "Pipeline: OCR (browser) → GPT-4o text rows → image consensus + reconcile. Weak OCR or column bleed can cause stable gaps.",
    );
  }
  if (ded && fin?.expectedTotalGbp != null) {
    const d = ded.sum - fin.expectedTotalGbp;
    if (Math.abs(d) > 0.05) {
      notes.push(
        `After dedupe, row sum was £${ded.sum.toFixed(2)} vs consensus expected £${fin.expectedTotalGbp.toFixed(2)} (Δ £${d.toFixed(2)}). Reconcile must move a lot — check OCR line pairing or consensus total label.`,
      );
    }
  }
  if (lastRec && !lastRec.matched && lastRec.gapGbp != null) {
    notes.push(
      `Last reconcile gap £${lastRec.gapGbp.toFixed(2)} — consider: duplicate row, missing CR credit, wrong GBP column vs USD text, transposed digits, or wrong printed total anchor.`,
    );
  }
  const gaps = r.server.reconcile
    .filter((x) => x.gapGbp != null && !x.matched)
    .map((x) => x.gapGbp!);
  if (gaps.length >= 2) {
    const variance = Math.max(...gaps) - Math.min(...gaps);
    if (variance > 5) {
      notes.push(
        "Reconcile gaps varied widely across attempts — model may be chasing different hypotheses; tighten anchored expected_total or reduce conflicting reconcile strategies.",
      );
    }
  }
  if (notes.length === 0) {
    notes.push("No automatic flags — run again and compare markdown across runs.");
  }
  return notes;
}

export function buildAlgorithmTuningMarkdown(r: ConsistencyReport): string {
  const lines: string[] = [];
  lines.push("# Extraction consistency report");
  lines.push("");
  lines.push(`Generated: ${r.startedAtIso}`);
  lines.push("");
  lines.push("## Client");
  lines.push("");
  lines.push(`- File: ${r.client?.fileName ?? "(unknown)"}`);
  lines.push(
    `- Approx OCR text chars (uploaded): ${r.client?.ocrTextCharsApprox ?? "n/a"}`,
  );
  lines.push(
    `- Upload images payload: ${r.client?.uploadPayloadKb != null ? `~${r.client.uploadPayloadKb} KB` : "n/a"}`,
  );
  lines.push("");
  lines.push("## Server trace");
  lines.push("");
  lines.push(`- Extraction path: **${r.server.extraction ?? "n/a"}**`);
  lines.push(`- Pages: ${r.server.pageCount ?? "n/a"}`);
  if (r.server.imageSizesKB?.length) {
    lines.push(
      `- Image sizes (KB): ${r.server.imageSizesKB.join(", ")}`,
    );
  }
  lines.push("");
  lines.push("### Per-page row counts (pre-dedupe)");
  lines.push("");
  if (r.server.perPage.length === 0) {
    lines.push("(none captured)");
  } else {
    for (const p of r.server.perPage) {
      lines.push(`- Page ${p.page}: ${p.rowCount} lines`);
    }
  }
  lines.push("");
  if (r.server.dedupe) {
    lines.push("### After cross-page dedupe");
    lines.push("");
    lines.push(`- Rows: ${r.server.dedupe.rowCount}`);
    lines.push(`- Sum (GBP): £${r.server.dedupe.sum.toFixed(2)}`);
    lines.push("");
  }
  lines.push("### Reconcile attempts");
  lines.push("");
  if (r.server.reconcile.length === 0) {
    lines.push("(none captured)");
  } else {
    for (const x of r.server.reconcile) {
      const gap =
        x.gapGbp != null && Number.isFinite(x.gapGbp)
          ? `gap £${x.gapGbp.toFixed(2)}`
          : "gap n/a";
      lines.push(
        `- Attempt ${x.attempt}/${x.maxAttempts} (${x.method || "?"}) — sum ${Number.isFinite(x.sum) ? `£${x.sum.toFixed(2)}` : "n/a"} — expected ${x.expectedTotal != null ? `£${x.expectedTotal.toFixed(2)}` : "n/a"} — ${x.matched ? "MATCHED" : "no match"} — ${gap}`,
      );
    }
  }
  lines.push("");
  if (r.server.final) {
    lines.push("### Final payload to UI");
    lines.push("");
    lines.push(`- Rows: ${r.server.final.rowCount}`);
    lines.push(`- Sum (GBP): £${r.server.final.sumGbp.toFixed(2)}`);
    lines.push(
      `- Expected total (GBP): ${r.server.final.expectedTotalGbp != null ? `£${r.server.final.expectedTotalGbp.toFixed(2)}` : "n/a"}`,
    );
    lines.push(
      `- Foots within 1p: **${r.server.final.reconciled ? "yes" : "no"}**`,
    );
    lines.push("");
  }
  lines.push("## Heuristic notes (for prompt / code changes)");
  lines.push("");
  for (const n of heuristicNotes(r)) {
    lines.push(`- ${n}`);
  }
  lines.push("");
  lines.push("## Raw JSON (paste into tooling)");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(r, null, 2));
  lines.push("```");
  return lines.join("\n");
}
