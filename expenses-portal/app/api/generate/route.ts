import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { coerceCategory } from "@/lib/categories";
import { fillTemplate, type ExpenseRow } from "@/lib/excel";
import { TEMPLATE_MAX_EXPENSE_ROWS } from "@/lib/statement-sort";

export const runtime = "nodejs";

const RowInSchema = z.object({
  narrative: z
    .union([z.string(), z.number(), z.null()])
    .transform((v) => (v == null ? "" : String(v))),
  category: z
    .union([z.string(), z.number(), z.null()])
    .transform((v) => (v == null ? "" : String(v))),
  gross: z.preprocess((v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }, z.number()),
});

const BodySchema = z.object({
  meta: z.object({
    name: z.string().default(""),
    month: z.string().default(""),
    card: z.string().default(""),
  }),
  rows: z.array(RowInSchema).min(1, "At least one row is required"),
});

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const body = BodySchema.parse(json);

    if (body.rows.length > TEMPLATE_MAX_EXPENSE_ROWS) {
      return NextResponse.json(
        {
          error: `Too many rows (${body.rows.length}). Maximum supported is ${TEMPLATE_MAX_EXPENSE_ROWS}.`,
        },
        { status: 400 },
      );
    }

    const rows: ExpenseRow[] = body.rows.map((r) => ({
      narrative: r.narrative.trim() || "(no description)",
      category: coerceCategory(r.category),
      gross: r.gross,
    }));

    const buffer = await fillTemplate(rows, body.meta);

    const filename = `Card Expenses Form ${body.meta.month || "Month"}.xlsx`;
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(
          filename,
        )}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[/api/generate]", err);
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: `Invalid request: ${err.issues.map((i) => i.message).join("; ")}` },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Generate failed: ${message}` },
      { status: 500 },
    );
  }
}
