import ExcelJS from "exceljs";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { Category } from "./categories";

export interface ExpenseRow {
  narrative: string;
  category: Category;
  gross: number;
}

export interface TemplateMeta {
  name: string;
  month: string;
  card: string;
}

const TEMPLATE_PATH = path.join(
  process.cwd(),
  "templates",
  "card-expenses-form.xlsx",
);

const HEADER_ROW = 6;
const FIRST_DATA_ROW = 7;
/** Last data row in the unmodified template (74 lines of data). */
const LAST_DATA_ROW = 80;
/** Row immediately below the data block in the template (TOTAL £). */
const TOTAL_ROW_IN_TEMPLATE = 81;
/** First / last template rows of the per-category SUMIFS summary (column D = category name). */
const TEMPLATE_SUMMARY_FIRST_DATA_ROW = 84;
const TEMPLATE_SUMMARY_LAST_DATA_ROW = 106;
const BUILTIN_DATA_ROW_COUNT = LAST_DATA_ROW - FIRST_DATA_ROW + 1;
const TEMPLATE_RANGE_END = LAST_DATA_ROW;
const SUMMARY_CATEGORY_ROW_COUNT =
  TEMPLATE_SUMMARY_LAST_DATA_ROW - TEMPLATE_SUMMARY_FIRST_DATA_ROW + 1;

/** Narrative column (B) — template may centre; export should be left-aligned. */
const NARRATIVE_ALIGNMENT: Partial<ExcelJS.Alignment> = {
  horizontal: "left",
  vertical: "middle",
  wrapText: true,
};

function copyRowPresentation(
  sheet: ExcelJS.Worksheet,
  fromRowNum: number,
  toRowNum: number,
) {
  const src = sheet.getRow(fromRowNum);
  const dst = sheet.getRow(toRowNum);
  if (src.height) dst.height = src.height;
  src.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const dest = dst.getCell(colNumber);
    dest.style = { ...cell.style };
  });
}

/**
 * Insert rows before the TOTAL row when there are more than 74 expense lines.
 * Formula repair runs separately in finalizeWorkbookFormulas.
 */
function expandExpenseTable(sheet: ExcelJS.Worksheet, lastDataRow: number) {
  if (lastDataRow <= TEMPLATE_RANGE_END) return;

  const extra = lastDataRow - TEMPLATE_RANGE_END;
  const emptyInserts = Array.from({ length: extra }, () => [] as unknown[]);
  sheet.spliceRows(TOTAL_ROW_IN_TEMPLATE, 0, ...emptyInserts);

  for (let r = TEMPLATE_RANGE_END + 1; r <= lastDataRow; r++) {
    copyRowPresentation(sheet, TEMPLATE_RANGE_END, r);
  }
}

/**
 * Strip all shared formulas from the expense + summary blocks. spliceRows and
 * partial edits otherwise leave invalid si/ref XML and Excel shows "repair".
 */
function finalizeWorkbookFormulas(sheet: ExcelJS.Worksheet, lastDataRow: number) {
  const extra = Math.max(0, lastDataRow - TEMPLATE_RANGE_END);
  /** Sum range always covers the full table down to last used or template end */
  const L = Math.max(lastDataRow, TEMPLATE_RANGE_END);

  for (let r = FIRST_DATA_ROW; r <= L; r++) {
    sheet.getCell(`E${r}`).value = { formula: `G${r}-F${r}` };
  }

  const totalRow = TOTAL_ROW_IN_TEMPLATE + extra;
  sheet.getCell(`E${totalRow}`).value = {
    formula: `SUM(E${FIRST_DATA_ROW}:E${L})`,
  };
  sheet.getCell(`F${totalRow}`).value = {
    formula: `SUM(F${FIRST_DATA_ROW}:F${L})`,
  };
  sheet.getCell(`G${totalRow}`).value = {
    formula: `SUM(G${FIRST_DATA_ROW}:G${L})`,
  };

  const summaryStart = TEMPLATE_SUMMARY_FIRST_DATA_ROW + extra;
  const summaryEnd = summaryStart + SUMMARY_CATEGORY_ROW_COUNT - 1;

  for (let i = 0; i < SUMMARY_CATEGORY_ROW_COUNT; i++) {
    const r = summaryStart + i;
    const dRef = `D${r}`;
    sheet.getCell(`E${r}`).value = {
      formula: `SUMIFS($E$7:$E$${L},$D$7:$D$${L},${dRef})`,
    };
    sheet.getCell(`F${r}`).value = {
      formula: `SUMIFS($F$7:$F$${L},$D$7:$D$${L},${dRef})`,
    };
    sheet.getCell(`G${r}`).value = {
      formula: `SUMIFS($G$7:$G$${L},$D$7:$D$${L},${dRef})`,
    };
  }

  const totalsRow = summaryEnd + 1;
  sheet.getCell(`E${totalsRow}`).value = {
    formula: `SUM(E${summaryStart}:E${summaryEnd})`,
  };
  sheet.getCell(`F${totalsRow}`).value = {
    formula: `SUM(F${summaryStart}:F${summaryEnd})`,
  };
  sheet.getCell(`G${totalsRow}`).value = {
    formula: `SUM(G${summaryStart}:G${summaryEnd})`,
  };
}

/**
 * Fill the bundled template with rows + metadata and return the resulting xlsx buffer.
 * Inserts extra rows before the TOTAL row when needed; preserves E = G − F, SUM, and SUMIFS.
 */
export async function fillTemplate(
  rows: ExpenseRow[],
  meta: TemplateMeta,
): Promise<Buffer> {
  const fileBuffer = await fs.readFile(TEMPLATE_PATH);

  const workbook = new ExcelJS.Workbook();
  // exceljs accepts ArrayBuffer-like - pass the underlying buffer slice
  await workbook.xlsx.load(
    fileBuffer.buffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset + fileBuffer.byteLength,
    ) as ArrayBuffer,
  );

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Template has no worksheet");

  sheet.getCell("B2").value = meta.name;
  sheet.getCell("B3").value = meta.month;
  sheet.getCell("B4").value = meta.card;

  const lastDataRow = FIRST_DATA_ROW + rows.length - 1;
  if (rows.length > BUILTIN_DATA_ROW_COUNT) {
    expandExpenseTable(sheet, lastDataRow);
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const r = FIRST_DATA_ROW + i;
    const bCell = sheet.getCell(`B${r}`);
    bCell.value = row.narrative;
    bCell.alignment = { ...bCell.alignment, ...NARRATIVE_ALIGNMENT };
    sheet.getCell(`C${r}`).value = row.category;
    sheet.getCell(`D${r}`).value = row.category;
    sheet.getCell(`G${r}`).value = row.gross;
  }

  finalizeWorkbookFormulas(sheet, lastDataRow);

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

export {
  HEADER_ROW,
  FIRST_DATA_ROW,
  LAST_DATA_ROW,
  BUILTIN_DATA_ROW_COUNT,
};
