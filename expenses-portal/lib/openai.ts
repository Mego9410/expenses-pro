import OpenAI from "openai";
import { z } from "zod";
import { CATEGORIES, type Category, coerceCategory } from "./categories";
import {
  sortRowsForStatement,
  TEMPLATE_MAX_EXPENSE_ROWS,
} from "./statement-sort";

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Add it to .env.local and restart the dev server.",
      );
    }
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

/** Integer seed for reproducible sampling (vision is still best-effort, not cryptographic). */
function getOpenAiSeed(): number {
  const raw = process.env.OPENAI_SEED;
  if (raw === undefined || raw === "") return 424_242;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 424_242;
}

/** Shared sampling defaults for every vision / JSON call. */
const DETERMINISTIC_LLM = {
  temperature: 0,
  top_p: 1,
  seed: getOpenAiSeed(),
  frequency_penalty: 0,
  presence_penalty: 0,
} as const;

export const ExtractedRowSchema = z.object({
  narrative: z.string().min(1),
  gross: z.number(),
  category: z.string().min(1),
  /** As printed in the left column, e.g. "20 Mar 2026". */
  transaction_date: z.string().min(1),
  /** Set in code when merging pages; reconciliation overwrites with global order. */
  statement_index: z.number().int().positive().optional(),
});
export type ExtractedRow = z.infer<typeof ExtractedRowSchema> & {
  category: Category;
};

const ResponseSchema = z.object({
  rows: z.array(ExtractedRowSchema),
});

const ReconcileRowSchema = z.object({
  narrative: z.string().min(1),
  gross: z.number(),
  category: z.string().min(1),
  transaction_date: z.string().min(1),
  statement_index: z.number().int().positive(),
});

const ReconcileResponseSchema = z.object({
  expected_total: z.number(),
  rows: z.array(ReconcileRowSchema),
});

const CATEGORY_GUIDANCE = `Guidance for picking a category from the merchant / context:
- Train tickets, rail operators (Avanti, LNER, GWR, Trainline, etc.) -> "Trains"
- Taxis, Uber, Bolt, buses, flights, airline tickets, car hire, fuel -> "Other travel"
- Hotel stays, Airbnb, B&B -> "Hotels"
- Car parks, NCP, Q-Park, congestion charge, ULEZ -> "Parking"
- Food/drink while travelling/working (cafes, takeaways, supermarket meal deals) -> "Subsistence"
- Restaurants where hosting clients/guests -> "Entertaining"
- Tea/coffee/snacks for the office -> "Office refreshments"
- Software subscriptions (Adobe, MS365, AWS, etc.), hardware, domains, hosting -> "IT"
- Books, courses, conferences -> "Training"
- Stamps, Royal Mail, couriers, DHL, FedEx -> "Postage"
- Pens, paper, printer ink, office supplies -> "Stationery"
- Magazine/journal/newspaper subscriptions -> "Subscriptions"
- Adverts, sponsored posts, Google/Meta ads -> "Advertising"
- PR agencies, marketing services -> "Marketing and PR"
- Client gifts, flowers, hampers -> "Gifts"
- Charitable donations -> "Donations"
- Networking events, prospect lunches -> "Business Development"
- Office/property repairs, cleaning, maintenance -> "Property repairs/renewals"
- Office rent, rates, utilities -> "Premises expenses"
- ATM cash withdrawals or generic small cash purchases -> "Petty Cash"
- Credit card fees, FX/non-sterling fees, interest -> "Card charges"
- Anything explicitly for "Principals Club" -> "Principals Club"
- Partner draws / LLP-related -> "LLP"
- If genuinely unsure, pick "Subsistence".`;

const SYSTEM_PROMPT = `You are an expert bookkeeper extracting line items from a scanned credit-card statement (e.g. Barclaycard).

You will be shown a single page from the PDF. The layout is a TABLE: a left column of dates, a middle block of merchant/description text, and a right column of GBP amounts. Do NOT try to "match" description text to amounts by guessing across blank space. Instead you MUST use the ORDERING METHOD below.

=== PAIRING / ORDERING METHOD (mandatory) ===

1. Scan the page from TOP to BOTTOM. In the LEFT date column, list every TRANSACTION DATE that starts a new line item (e.g. "20 Mar 2026"). Skip any date that belongs to a summary / heading row (see LINES TO SKIP). Call this ordered list D1, D2, D3, … Dn.

2. In the RIGHT amount column, list every TRANSACTION TOTAL amount that belongs to those same rows, in the SAME top-to-bottom order: A1, A2, A3, … An.
   - Each transaction usually has ONE primary GBP total in the amount column (often right-aligned with the first line of that transaction).
   - IGNORE numbers that appear INSIDE the description block (e.g. "29.00 U.S. DOLLAR", FX rates, reference numbers, fees shown as separate lines inside the text). The gross for row i is ALWAYS the main GBP amount in the amount column on the same transaction band as Di — typically Ai is the i-th such amount counting from the top of the transaction list.
   - If an amount shows "CR", it is still the i-th amount in order; output it as NEGATIVE (see CR rule).

3. For the DESCRIPTION / TITLE: for transaction i, the "narrative" is the FIRST line of merchant or title text that belongs to the SAME transaction block as Di (the text beside or immediately following that date — usually the merchant name on the first line of the entry). If the entry has continuation lines (reference numbers, "DIGITAL GOODS", FX detail), do NOT use those as the narrative unless there is no merchant line — prefer the first human-readable merchant/title line.

4. Output EXACTLY n rows in the SAME ORDER as D1…Dn: row 1 = (narrative from block 1, gross from A1), row 2 = (block 2, A2), etc. This sequential pairing prevents errors from mis-linking text and amounts across whitespace.

5. If you are unsure which amount pairs with which date, trust VERTICAL ORDER: the k-th qualifying date from the top pairs with the k-th qualifying GBP total from the top (excluding skipped summary rows).

THE DATE RULE: EVERY qualifying transaction date Di produces EXACTLY ONE output row in position i. If you see 7 qualifying dates, you must output 7 rows in that order. Credits with a date are included; they are still one row each with negative gross.

CR / CREDIT RULE: Amounts with the suffix "CR" (e.g. "45.00CR", "12.34 CR") are CREDITS — they REDUCE the balance. Output them as a NEGATIVE number (e.g. "12.34CR" -> gross: -12.34). DO NOT skip them. DO NOT output them as positive. EVERY dated line with a CR amount must produce exactly one row, with a negative gross.

LINES TO SKIP (these are NOT new transactions — they are summary / carried-forward entries):
- "Previous balance" / "Balance brought forward" / "Opening balance"
- "Payment received" / "Payment - thank you" / "Direct debit received" / "PAYMENT RECEIVED — THANK YOU"
- "Closing balance" / "New balance" / "Total payments due" / "Amount due"
- "Total payments" / "Total debits this period" / "Total credits this period" / any sub-total or grand total row
- Any row that is clearly a heading, sub-heading, or summary band rather than a merchant transaction.
ONLY include lines representing NEW merchant transactions (a real shop / supplier / service charged to the card this period).

For each transaction line item, output one row with:
- "transaction_date": the date EXACTLY as printed in the left column for that line (e.g. "20 Mar 2026"). Same format as on the statement.
- "narrative": the MERCHANT NAME as printed on the statement line (the shop, restaurant, supplier, etc.). Read it verbatim — do not paraphrase, do not invent. If you genuinely cannot read the merchant, write "(unreadable)".
- "gross": the amount in GBP as a number (no currency symbol, no commas). Positive for debits, NEGATIVE for "CR" credits.
- "category": the accounting bucket. MUST be EXACTLY one of these strings (case-sensitive):
${CATEGORIES.map((c) => `  - ${c}`).join("\n")}

${CATEGORY_GUIDANCE}

CRITICAL rules:
1. Do NOT invent transactions. Only output rows for lines you can actually see on the page.
2. Do NOT skip any qualifying dated transaction line, including small amounts and credits ("CR"). The count of rows must equal the count of qualifying dates in order.
3. Apply the LINES TO SKIP list above strictly — these are summary entries, not transactions.
4. If the same line clearly appears twice (duplicate scan on the SAME page), only include it once. Otherwise, do not deduplicate.
5. Read the amount carefully — distinguish 1 from 7, 0 from 8, missed decimal points. ALWAYS check for a trailing "CR" — if present, the gross is NEGATIVE.
6. Look all the way to the BOTTOM of the page — the last qualifying date and its paired amount must be included (the last row in your ordered list).
7. Return ONLY valid JSON matching the schema. Do not add commentary.`;

const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          narrative: { type: "string" },
          gross: { type: "number" },
          transaction_date: { type: "string" },
          category: {
            type: "string",
            enum: [...CATEGORIES],
          },
        },
        required: ["narrative", "gross", "transaction_date", "category"],
      },
    },
  },
  required: ["rows"],
} as const;

function dataUrlForImageBuffer(buf: Buffer): string {
  const isJpeg =
    buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const mime = isJpeg ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function extractFromImage(
  pngBuffer: Buffer,
  pageIndex: number,
): Promise<ExtractedRow[]> {
  const started = Date.now();
  console.log(
    `[extract] page ${pageIndex + 1}: starting (${(pngBuffer.length / 1024).toFixed(0)} KB image)`,
  );
  const response = await getClient().chat.completions.create({
    model: "gpt-4o",
    ...DETERMINISTIC_LLM,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "expense_extraction",
        strict: true,
        schema: EXTRACTION_JSON_SCHEMA,
      },
    },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Here is one page from a scanned credit-card statement. Use the PAIRING METHOD from the system prompt: list dates top-to-bottom, pair the i-th date with the i-th GBP total in the amount column, and use the first merchant/title line for each block. For every row include transaction_date exactly as printed in the left column (e.g. 20 Mar 2026). Ignore USD and inline numbers inside descriptions. Include every qualifying date including the last one on the page. CR amounts must be negative.",
          },
          {
            type: "image_url",
            image_url: {
              url: dataUrlForImageBuffer(pngBuffer),
              detail: "high",
            },
          },
        ],
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  const finishReason = response.choices[0]?.finish_reason;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[extract] page ${pageIndex + 1}: done in ${elapsed}s, finish=${finishReason}, raw chars=${raw?.length ?? 0}`,
  );
  if (!raw) {
    console.warn(
      `[extract] page ${pageIndex + 1}: empty content. Full response:`,
      JSON.stringify(response).slice(0, 500),
    );
    return [];
  }
  let parsed;
  try {
    parsed = ResponseSchema.parse(JSON.parse(raw));
  } catch (err) {
    console.error(
      `[extract] page ${pageIndex + 1}: failed to parse:`,
      err,
      "raw:",
      raw.slice(0, 500),
    );
    return [];
  }
  console.log(
    `[extract] page ${pageIndex + 1}: extracted ${parsed.rows.length} row(s)`,
  );
  return parsed.rows.map((r) => ({
    ...r,
    category: coerceCategory(r.category),
  }));
}

function sumRows(rows: ExtractedRow[]): number {
  return rows.reduce((s, r) => s + (Number.isFinite(r.gross) ? r.gross : 0), 0);
}

/** Picks the reconciliation attempt closest to the statement total (smallest |sum - expected|). */
type ReconcileBestState = {
  rows: ExtractedRow[];
  attempt: number;
  gap: number;
  matched: boolean;
};

function scoreRowsAgainstExpected(
  rows: ExtractedRow[],
  attempt: number,
  expected: number,
): ReconcileBestState {
  const sum = sumRows(rows);
  const gap = Math.abs(sum - expected);
  const matched = gap <= 0.01;
  return { rows, attempt, gap, matched };
}

/** True if `cand` should replace `best` (smaller gap; ties → matched; then earlier attempt). */
function reconciliationCandidateWins(
  cand: ReconcileBestState,
  best: ReconcileBestState,
): boolean {
  if (cand.gap < best.gap) return true;
  if (cand.gap > best.gap) return false;
  if (cand.matched && !best.matched) return true;
  if (!cand.matched && best.matched) return false;
  return cand.attempt < best.attempt;
}

const RECONCILE_BASE = `You are an expert bookkeeper auditing line items extracted from a scanned credit-card statement.

You will be shown:
1. EVERY page image of the statement.
2. The JSON array of rows that another model extracted from those pages.

Your job is always:
A. Find the PRINTED GRAND TOTAL OF NEW TRANSACTIONS THIS PERIOD on the statement. This is the figure that equals (sum of new debits this period) - (sum of new credits this period). It is typically labelled one of:
   - "Total payments" / "Total of new transactions this period"
   - "Total debits this period" (less any "Total credits this period")
   - The "TOTAL" figure printed adjacent to / at the bottom of the transactions list.
   It is NOT the "Closing balance" / "New balance" — those include the previous balance carried forward and any payments received, which are NOT new transactions.
   It is NOT the "Previous balance" / "Balance brought forward" / "Opening balance".
   It is NOT the "Amount due" if that includes carried-forward balance.
   If multiple totals appear, PREFER the one labelled "TOTAL" right next to the transactions list, or compute (sum of new debits) - (sum of new credits) from the printed sub-totals.
   Report this figure in "expected_total" (a number, e.g. 2725.72).
B. Return a "rows" array such that sum(rows[i].gross) EXACTLY equals expected_total (to 2dp).

Shared rules for ALL methods:
- Amounts with the suffix "CR" are CREDITS — output as NEGATIVE gross.
- Do NOT include summary rows: "Previous balance", "Balance brought forward", "Opening balance", "Payment received", "Payment - thank you", "Direct debit received", "Closing balance", "New balance", "Total payments due", "Amount due", or sub-totals/headings.
- Ignore USD and inline FX figures inside descriptions; use only the main GBP column total per transaction.

STATEMENT ORDER (mandatory — do NOT append fixed rows only at the end of the array):
- Every row MUST include "statement_index": a positive integer. Use 1 for the first qualifying transaction at the TOP of page 1, then 2, 3, 4, … in strict visual order (top-to-bottom within each page, then page 2, etc.).
- The JSON "rows" array MUST be ordered with statement_index ascending. If you add or correct a row, place it at the position that matches where it appears on the paper — never leave new rows only at the bottom unless they truly are the last transactions on the last page.
- Every row MUST include "transaction_date" exactly as printed in the left column (e.g. "20 Mar 2026").
- After reconciliation, the app sorts rows by transaction_date (earliest first), then statement_index for same-day ties — so dates must be correct even if visual order on the PDF differs.

For each row:
- "statement_index": position in the full statement (see above)
- "transaction_date": date as printed on that line
- "narrative": merchant name as printed
- "gross": GBP amount as a number, negative for CR credits
- "category": one of:
${CATEGORIES.map((c) => `  - ${c}`).join("\n")}

${CATEGORY_GUIDANCE}

Return ONLY valid JSON with shape { "expected_total": number, "rows": [...] }. The sum of gross across rows must equal expected_total to within 0.01.`;

/** Reconciliation pass index; each value uses a different prompt strategy. */
export type ReconcileAttempt = 1 | 2 | 3 | 4 | 5;

/** Different strategy each attempt so retries are not identical reruns. */
function reconcileStrategySection(attempt: ReconcileAttempt): string {
  if (attempt === 1) {
    return `
=== RECONCILIATION METHOD 1 (pairing audit) ===
Use the SAME pairing rule as extraction: on each page, list qualifying dates in the left column top-to-bottom (D1…Dn). List main GBP amounts in the amount column in the same order (A1…An). Row i pairs Di with Ai; narrative = first merchant line for that block. Audit the supplied JSON against the images; fix order, missing lines, wrong amounts, duplicates, and hallucinations.`;
  }
  if (attempt === 2) {
    return `
=== RECONCILIATION METHOD 2 (amount-spine rebuild) ===
Do NOT trust the previous rows' amounts for pairing. Rebuild from scratch using the AMOUNT COLUMN as the spine:
1. On each page, read ONLY the right-hand GBP transaction totals in strict top-to-bottom order (each row's final GBP figure; CR → negative). Skip summary bands.
2. Independently list qualifying dates top-to-bottom on each page.
3. The count of dates and the count of GBP totals must match per page; pair strictly by index i (i-th date with i-th amount).
4. For narrative, take the first merchant/title line in the block beside that date.
5. If the prior run was wrong, it often confused an inline USD or fee with the GBP total — re-verify every gross against the amount column only.
This is a different procedure from Method 1; apply it fully.`;
  }
  if (attempt === 3) {
    return `
=== RECONCILIATION METHOD 3 (delta / root-cause) ===
Prior passes may have repeated the same mistake. Use arithmetic + targeted search:
1. Compare expected_total (from the statement) to what a full re-scan of ALL GBP line totals would imply. The discrepancy is often ONE of: a duplicated row, a missing CR credit, one amount taken from USD text instead of GBP column, transposed digits (e.g. 17.60 vs 71.60), or an extra non-transaction row.
2. Explicitly search the images for a single correction that closes the gap (or the smallest set of corrections). Prefer fixing one mis-read amount over reshuffling many rows.
3. Rebuild the final rows so the sum matches expected_total exactly — you may need to remove a duplicate, add a missing dated line, or correct one gross to match the scanned amount column.
This method prioritises finding the ROOT CAUSE of the mismatch over lightly editing the previous JSON.`;
  }
  if (attempt === 4) {
    return `
=== RECONCILIATION METHOD 4 (date-ordered spine) ===
Rebuild with DATES driving structure first (contrast with Method 2, which starts from amounts):
1. In strict reading order (page 1 top-to-bottom, then page 2, etc.), list every printed qualifying transaction date.
2. For each date line in that order, attach exactly one GBP total from the main amount column for that row (CR → negative). Do not pair across different visual rows.
3. If several transactions share the same calendar date, keep the vertical order exactly as on the paper.
4. Reconcile counts: the number of date lines must equal the number of rows; fix missing or phantom rows before tweaking amounts.
5. Then align narratives to the merchant text beside each paired date/amount block.`;
  }
  return `
=== RECONCILIATION METHOD 5 (minimal edit from current JSON) ===
Treat the supplied rows as the default hypothesis; satisfy expected_total with the smallest plausible change set:
1. Prefer ONE corrected gross to match the image, OR removing ONE spurious row, OR adding ONE missing row — over large reshuffles.
2. If reordering is needed, limit to swaps that fix a clear mismatch visible next to the date column.
3. Compute the GBP gap vs expected_total; before multi-line edits, list single-line adjustments that could absorb that gap (dupes, CR sign, wrong column, transposed digits).
4. Only expand to broader rebuilds if no small fix explains the images.
5. Output final rows whose sum equals expected_total to 2dp.`;
}

function buildReconcileSystemPrompt(attempt: ReconcileAttempt): string {
  return `${RECONCILE_BASE}\n${reconcileStrategySection(attempt)}`;
}

const StatementTotalResponseSchema = z.object({
  found: z.boolean(),
  expected_total: z.number(),
});

const STATEMENT_TOTAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean" },
    expected_total: { type: "number" },
  },
  required: ["found", "expected_total"],
} as const;

const STATEMENT_TOTAL_SYSTEM = `You read UK-style credit-card statement images. Reply with JSON only.

Find the single figure that is the GRAND TOTAL OF NEW TRANSACTIONS THIS BILLING PERIOD (new debits minus new credits in the itemized list). It is what should foot to the sum of the transaction lines — NOT "Closing balance", NOT "New balance", NOT "Previous balance" / "Balance brought forward", NOT "Payment received" / "Thank you", NOT "Amount due" if that mixes in carried-forward balance.

Prefer a line labelled like: "Total payments", "Total of new transactions", "Total debits this period" (net of credits), or a bold TOTAL aligned with the end of the transaction table.

Set "found" to true only if you clearly read that total. Set "found" to false if the statement is unreadable or ambiguous — do not guess a random number when unsure.

When found is true, "expected_total" must match the printed GBP total to 2 decimal places.`;

async function readStatementTotalOnce(
  pngBuffers: Buffer[],
  seed: number,
): Promise<number | null> {
  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: "text",
      text: `You are given ${pngBuffers.length} scanned page(s) of ONE statement (in order). Read the total described in the system prompt.`,
    },
    ...pngBuffers.map(
      (buf) =>
        ({
          type: "image_url",
          image_url: {
            url: dataUrlForImageBuffer(buf),
            detail: "high" as const,
          },
        }) as OpenAI.Chat.Completions.ChatCompletionContentPart,
    ),
  ];

  const response = await getClient().chat.completions.create({
    model: "gpt-4o",
    ...DETERMINISTIC_LLM,
    seed,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "statement_total_only",
        strict: true,
        schema: STATEMENT_TOTAL_JSON_SCHEMA,
      },
    },
    messages: [
      { role: "system", content: STATEMENT_TOTAL_SYSTEM },
      { role: "user", content: userContent },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) return null;
  try {
    const parsed = StatementTotalResponseSchema.parse(JSON.parse(raw));
    if (!parsed.found) return null;
    return parsed.expected_total;
  } catch {
    return null;
  }
}

/**
 * Two independent reads (different seeds) + median if they disagree —
 * stabilises the target total before row-level reconciliation.
 */
async function resolveStatementTotal(
  pngBuffers: Buffer[],
): Promise<number | null> {
  if (pngBuffers.length === 0) return null;
  const base = getOpenAiSeed();
  const [a, b] = await Promise.all([
    readStatementTotalOnce(pngBuffers, base),
    readStatementTotalOnce(pngBuffers, base + 1_001_001),
  ]);
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  if (Math.abs(a - b) <= 0.02) return (a + b) / 2;
  const c = await readStatementTotalOnce(pngBuffers, base + 2_002_002);
  if (c === null) return (a + b) / 2;
  const sorted = [a, b, c].sort((x, y) => x - y);
  return sorted[1]!;
}

export const RECONCILE_METHOD_LABELS: Record<ReconcileAttempt, string> = {
  1: "Pairing audit",
  2: "Amount-spine rebuild",
  3: "Delta / root-cause",
  4: "Date-ordered spine",
  5: "Minimal edit",
};

const RECONCILE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    expected_total: { type: "number" },
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          narrative: { type: "string" },
          gross: { type: "number" },
          transaction_date: { type: "string" },
          statement_index: { type: "integer", minimum: 1 },
          category: {
            type: "string",
            enum: [...CATEGORIES],
          },
        },
        required: [
          "narrative",
          "gross",
          "transaction_date",
          "statement_index",
          "category",
        ],
      },
    },
  },
  required: ["expected_total", "rows"],
} as const;

async function reconcileExpenses(
  pngBuffers: Buffer[],
  currentRows: ExtractedRow[],
  attempt: ReconcileAttempt,
  ctx: {
    sumBefore: number;
    expectedTotalHint: number | null;
    gap: number | null;
  },
): Promise<{ rows: ExtractedRow[]; expectedTotal: number | null }> {
  const started = Date.now();
  const currentSum = ctx.sumBefore;
  console.log(
    `[reconcile] attempt ${attempt} (method ${attempt}): ${currentRows.length} rows, sum=${currentSum.toFixed(2)}, ` +
      `hintExpected=${ctx.expectedTotalHint?.toFixed(2) ?? "n/a"}, gap=${ctx.gap?.toFixed(2) ?? "n/a"}, ${pngBuffers.length} page(s)`,
  );

  let gapNote = "";
  if (ctx.gap !== null && ctx.expectedTotalHint !== null) {
    const direction =
      ctx.gap > 0.01
        ? "sum is HIGHER than expected (possible extra debit, missing CR, or wrong positive amount)"
        : ctx.gap < -0.01
          ? "sum is LOWER than expected (possible missing debit, extra credit, or wrong negative)"
          : "sums already match — still verify rows against images";
    gapNote =
      `\n\nIMPORTANT — previous reconciliation did not match: current sum was ${currentSum.toFixed(2)} vs expected ${ctx.expectedTotalHint.toFixed(2)} (off by ${Math.abs(ctx.gap).toFixed(2)}). ${direction}.\n` +
      `You MUST follow the numbered RECONCILIATION METHOD ${attempt} in the system prompt exactly — do not merely repeat the same corrections as before.`;
  }

  const anchoredTotalNote =
    ctx.expectedTotalHint !== null
      ? `\n\nANCHORED TOTAL — an independent double-read of the images fixed the printed new-transactions total at ${ctx.expectedTotalHint.toFixed(2)} GBP. Your JSON "expected_total" MUST be exactly this number, and sum(rows[].gross) MUST equal it to 2dp. Do not substitute closing balance, new balance, or previous balance.`
      : "";

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: "text",
      text:
        `Here are all ${pngBuffers.length} page(s) of the credit-card statement, followed by the rows extracted so far.\n\n` +
        `Current extracted rows (JSON):\n${JSON.stringify(currentRows, null, 2)}\n\n` +
        `Current sum of gross: ${currentSum.toFixed(2)}.\n\n` +
        `Find the printed TOTAL OF NEW TRANSACTIONS THIS PERIOD (NOT the closing/new balance, NOT the previous balance). Return expected_total and a corrected rows array such that sum(rows.gross) == expected_total to 2dp.` +
        anchoredTotalNote +
        gapNote,
    },
    ...pngBuffers.map(
      (buf) =>
        ({
          type: "image_url",
          image_url: {
            url: dataUrlForImageBuffer(buf),
            detail: "high",
          },
        }) as OpenAI.Chat.Completions.ChatCompletionContentPart,
    ),
  ];

  const response = await getClient().chat.completions.create({
    model: "gpt-4o",
    ...DETERMINISTIC_LLM,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "expense_reconciliation",
        strict: true,
        schema: RECONCILE_JSON_SCHEMA,
      },
    },
    messages: [
      { role: "system", content: buildReconcileSystemPrompt(attempt) },
      { role: "user", content: userContent },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[reconcile] attempt ${attempt}: done in ${elapsed}s, raw chars=${raw?.length ?? 0}`,
  );
  if (!raw) {
    console.warn(`[reconcile] attempt ${attempt}: empty content`);
    return { rows: currentRows, expectedTotal: null };
  }
  let parsed;
  try {
    parsed = ReconcileResponseSchema.parse(JSON.parse(raw));
  } catch (err) {
    console.error(
      `[reconcile] attempt ${attempt}: failed to parse:`,
      err,
      "raw:",
      raw.slice(0, 500),
    );
    return { rows: currentRows, expectedTotal: null };
  }
  const correctedRows: ExtractedRow[] = parsed.rows.map((r) => ({
    narrative: r.narrative,
    gross: r.gross,
    transaction_date: r.transaction_date,
    statement_index: r.statement_index,
    category: coerceCategory(r.category),
  }));
  const newSum = sumRows(correctedRows);
  console.log(
    `[reconcile] attempt ${attempt}: model says expected_total=${parsed.expected_total.toFixed(2)}, ` +
      `corrected rows=${correctedRows.length}, new sum=${newSum.toFixed(2)}, ` +
      `diff=${Math.abs(newSum - parsed.expected_total).toFixed(2)}`,
  );
  return { rows: correctedRows, expectedTotal: parsed.expected_total };
}

export type ExtractProgressEvent =
  | { type: "page_start"; page: number; totalPages: number }
  | { type: "page_done"; page: number; totalPages: number; rowCount: number }
  | { type: "page_error"; page: number; totalPages: number; message: string }
  | { type: "dedupe_done"; rowCount: number; sum: number }
  | {
      type: "reconcile_start";
      attempt: number;
      maxAttempts: number;
      method: string;
    }
  | {
      type: "reconcile_done";
      attempt: number;
      maxAttempts: number;
      sum: number;
      expectedTotal: number | null;
      matched: boolean;
    }
  | {
      type: "python_parse_done";
      rowCount: number;
      expectedTotal: number | null;
      pageCount: number | null;
    }
  | {
      type: "categorize_chunk";
      index: number;
      totalChunks: number;
      size: number;
    };

export async function extractExpenses(
  pngBuffers: Buffer[],
  onEvent: (e: ExtractProgressEvent) => void = () => {},
): Promise<{ rows: ExtractedRow[]; expectedTotal: number | null }> {
  if (pngBuffers.length === 0) return { rows: [], expectedTotal: null };

  const totalPages = pngBuffers.length;
  const perPage: ExtractedRow[][] = [];
  for (let i = 0; i < pngBuffers.length; i++) {
    const buf = pngBuffers[i]!;
    onEvent({ type: "page_start", page: i + 1, totalPages });
    try {
      const pageRows = await extractFromImage(buf, i);
      onEvent({
        type: "page_done",
        page: i + 1,
        totalPages,
        rowCount: pageRows.length,
      });
      perPage.push(pageRows);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[extract] page ${i + 1} threw:`, err);
      onEvent({
        type: "page_error",
        page: i + 1,
        totalPages,
        message,
      });
      perPage.push([]);
    }
  }
  let seq = 0;
  const all = perPage.flat().map((r) => ({
    ...r,
    statement_index: ++seq,
  }));
  console.log(
    `[extract] total ${all.length} rows across ${pngBuffers.length} page(s) before reconciliation`,
  );

  // Light de-duplication across pages: same date + merchant + gross to 2dp.
  const seen = new Set<string>();
  let rows: ExtractedRow[] = [];
  for (const r of all) {
    const key = `${r.transaction_date}|${r.narrative.trim().toLowerCase()}|${r.gross.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(r);
  }
  rows = rows.map((r, i) => ({ ...r, statement_index: i + 1 }));
  console.log(
    `[extract] ${rows.length} rows after dedupe, sum=${sumRows(rows).toFixed(2)}`,
  );
  onEvent({
    type: "dedupe_done",
    rowCount: rows.length,
    sum: Number(sumRows(rows).toFixed(2)),
  });

  const consensusTotal = await resolveStatementTotal(pngBuffers);
  if (consensusTotal !== null) {
    console.log(
      `[extract] consensus printed new-transactions total: ${consensusTotal.toFixed(2)}`,
    );
  } else {
    console.log(
      "[extract] no consensus total from double-read — falling back to first reconcile pass for expected_total",
    );
  }

  // Reconcile against the printed statement total — up to 5 passes, different method each time.
  const MAX_ATTEMPTS = 5;
  /** Target total: double-read consensus when available, else first model-reported expected_total. */
  let stabilizedExpectedTotal: number | null = consensusTotal;
  let best: ReconcileBestState = {
    rows,
    attempt: 0,
    gap: Number.POSITIVE_INFINITY,
    matched: false,
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const attemptN = attempt as ReconcileAttempt;
    const inputRows = best.rows;
    const sumBefore = sumRows(inputRows);
    const gap =
      stabilizedExpectedTotal !== null
        ? Number((sumBefore - stabilizedExpectedTotal).toFixed(2))
        : null;
    onEvent({
      type: "reconcile_start",
      attempt,
      maxAttempts: MAX_ATTEMPTS,
      method: RECONCILE_METHOD_LABELS[attemptN],
    });
    const result = await reconcileExpenses(pngBuffers, inputRows, attemptN, {
      sumBefore,
      expectedTotalHint: stabilizedExpectedTotal,
      gap,
    });

    if (result.expectedTotal !== null) {
      if (stabilizedExpectedTotal === null) {
        stabilizedExpectedTotal = result.expectedTotal;
      } else if (
        Math.abs(result.expectedTotal - stabilizedExpectedTotal) > 0.01
      ) {
        console.warn(
          `[reconcile] attempt ${attempt}: model expected_total ${result.expectedTotal.toFixed(2)} ` +
            `differs from stabilized ${stabilizedExpectedTotal.toFixed(2)} — gaps use stabilized value`,
        );
      }
    }

    const compareExpected =
      stabilizedExpectedTotal ?? result.expectedTotal ?? null;

    if (compareExpected === null) {
      console.warn(
        `[reconcile] attempt ${attempt}: no expected_total returned, stopping`,
      );
      onEvent({
        type: "reconcile_done",
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        sum: Number(sumRows(result.rows).toFixed(2)),
        expectedTotal: null,
        matched: false,
      });
      break;
    }

    // Prefer the input (previous best) and this attempt's output — closest to statement total wins.
    const scoredInput = scoreRowsAgainstExpected(
      inputRows,
      best.attempt,
      compareExpected,
    );
    const scoredResult = scoreRowsAgainstExpected(
      result.rows,
      attempt,
      compareExpected,
    );
    let newBest = best;
    if (reconciliationCandidateWins(scoredInput, newBest)) newBest = scoredInput;
    if (reconciliationCandidateWins(scoredResult, newBest)) newBest = scoredResult;
    best = newBest;

    const attemptSum = sumRows(result.rows);
    const attemptMatched =
      Math.abs(attemptSum - compareExpected) <= 0.01;
    onEvent({
      type: "reconcile_done",
      attempt,
      maxAttempts: MAX_ATTEMPTS,
      sum: Number(attemptSum.toFixed(2)),
      expectedTotal: Number(compareExpected.toFixed(2)),
      matched: attemptMatched,
    });

    if (best.matched) {
      console.log(
        `[reconcile] reconciled (best attempt ${best.attempt}): sum matches expected_total ${compareExpected.toFixed(2)}`,
      );
      break;
    }
    console.log(
      `[reconcile] attempt ${attempt}: model output off by ${Math.abs(attemptSum - compareExpected).toFixed(2)}; ` +
        `best so far attempt ${best.attempt} off by ${best.gap.toFixed(2)}`,
    );
  }

  rows = best.rows;
  const expectedTotal = stabilizedExpectedTotal;

  rows = sortRowsForStatement(rows).map((r, i) => ({
    ...r,
    statement_index: i + 1,
  }));

  if (rows.length > TEMPLATE_MAX_EXPENSE_ROWS) {
    console.warn(
      `[extract] ${rows.length} rows exceed export cap (${TEMPLATE_MAX_EXPENSE_ROWS}); user must remove lines to generate the spreadsheet.`,
    );
  }
  console.log(
    `[extract] final ${rows.length} rows, sum=${sumRows(rows).toFixed(2)}, expectedTotal=${expectedTotal === null ? "n/a" : expectedTotal.toFixed(2)}`,
  );
  return { rows, expectedTotal };
}

const CATEGORY_ASSIGN_SYSTEM = `You assign ONLY the accounting category (Reason / Type of Expenditure) for each expense line.
Do not change amounts or dates. Use merchant text and context only.

${CATEGORY_GUIDANCE}

Return JSON with a "categories" array parallel to the batch: categories[i] is for line i (0-based within the batch).
Each string must be EXACTLY one of:
${CATEGORIES.map((c) => `  - ${c}`).join("\n")}`;

const CATEGORY_BATCH_SIZE = 36;

/** Vision-free path: rows from PDF text; OpenAI picks categories only. */
export async function categorizeExpenseRows(
  rows: { transaction_date: string; narrative: string; gross: number }[],
  onEvent: (e: ExtractProgressEvent) => void = () => {},
): Promise<ExtractedRow[]> {
  if (rows.length === 0) return [];

  const totalChunks = Math.ceil(rows.length / CATEGORY_BATCH_SIZE);
  const categoriesOut: Category[] = [];

  for (let c = 0; c < totalChunks; c++) {
    const offset = c * CATEGORY_BATCH_SIZE;
    const chunk = rows.slice(offset, offset + CATEGORY_BATCH_SIZE);
    const n = chunk.length;
    onEvent({
      type: "categorize_chunk",
      index: c + 1,
      totalChunks,
      size: n,
    });

    const lines = chunk
      .map(
        (r, i) =>
          `${i}. date=${r.transaction_date}; merchant=${r.narrative}; amount_gbp=${r.gross}`,
      )
      .join("\n");

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        categories: {
          type: "array",
          items: { type: "string", enum: [...CATEGORIES] },
          minItems: n,
          maxItems: n,
        },
      },
      required: ["categories"],
    } as const;

    const response = await getClient().chat.completions.create({
      model: "gpt-4o-mini",
      ...DETERMINISTIC_LLM,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "expense_categories_batch",
          strict: true,
          schema,
        },
      },
      messages: [
        { role: "system", content: CATEGORY_ASSIGN_SYSTEM },
        {
          role: "user",
          content: `Assign categories for these ${n} lines (indices 0..${n - 1}):\n\n${lines}`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) {
      throw new Error("Category assignment returned empty content");
    }
    let parsed: { categories?: unknown };
    try {
      parsed = JSON.parse(raw) as { categories?: unknown };
    } catch {
      throw new Error("Category assignment returned invalid JSON");
    }
    const arr = parsed.categories;
    if (!Array.isArray(arr)) {
      throw new Error('Category assignment missing "categories" array');
    }
    for (let i = 0; i < n; i++) {
      categoriesOut.push(coerceCategory(String(arr[i] ?? "Subsistence")));
    }
  }

  return rows.map((r, i) => ({
    transaction_date: r.transaction_date,
    narrative: r.narrative,
    gross: r.gross,
    category: categoriesOut[i]!,
  }));
}
