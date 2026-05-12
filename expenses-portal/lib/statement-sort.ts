/** Built-in expense table in the bundled template (rows 7–80). More rows are inserted at export. */
export const BUNDLED_TEMPLATE_DATA_ROWS = 74;
/** Hard cap for spreadsheet generation (abuse / memory). */
export const TEMPLATE_MAX_EXPENSE_ROWS = 2000;

const MONTH_MAP: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Parse "20 Mar 2026" style dates from UK statements. */
export function parseStatementDateMs(s: string): number {
  const m = s
    .trim()
    .match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (!m) return NaN;
  const day = parseInt(m[1], 10);
  const monKey = m[2].slice(0, 3).toLowerCase();
  const mon = MONTH_MAP[monKey];
  if (mon === undefined) return NaN;
  const year = parseInt(m[3], 10);
  return new Date(year, mon, day).getTime();
}

/**
 * Chronological order for reconciled data: sort by transaction_date ascending,
 * then by statement_index (document order within the same day).
 * We do NOT sort by statement_index alone — PDF page order can disagree with
 * calendar order if the model mis-numbered rows; users expect strict date order.
 */
export function sortRowsForStatement<
  T extends { statement_index?: number; transaction_date?: string },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = parseStatementDateMs(a.transaction_date ?? "");
    const tb = parseStatementDateMs(b.transaction_date ?? "");
    const aOk = !Number.isNaN(ta);
    const bOk = !Number.isNaN(tb);
    if (aOk && bOk && ta !== tb) return ta - tb;
    if (aOk && !bOk) return -1;
    if (!aOk && bOk) return 1;
    const ia = a.statement_index ?? 0;
    const ib = b.statement_index ?? 0;
    if (ia !== ib) return ia - ib;
    return (a.transaction_date ?? "").localeCompare(b.transaction_date ?? "");
  });
}
