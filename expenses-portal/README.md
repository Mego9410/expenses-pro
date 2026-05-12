# Expenses Portal

A small local web app: drop in a scanned PDF of credit-card receipts, and it
hands back a populated `Card Expenses Form .xlsx` based on your existing
template.

- **OCR & extraction**: OpenAI GPT-4o vision
- **Spreadsheet writing**: exceljs (preserves formulas, totals, summary)
- **PDF rasterization**: pdfjs-dist + @napi-rs/canvas
- **Framework**: Next.js 15 (App Router) + Tailwind

## Setup

1. Copy `.env.local.example` to `.env.local` and paste your OpenAI API key:

   ```
   OPENAI_API_KEY=sk-...
   ```

2. Install and run:

   ```bash
   npm install
   npm run dev
   ```

3. Open <http://localhost:3000>.

## How it works

- The template `templates/card-expenses-form.xlsx` is committed to the repo and
  used as the base every time. The portal never modifies it - it loads it,
  writes new rows into a copy, and streams that copy to your browser.
- Headers live in row 6; data is written into rows 7-80 of columns B
  (Narrative), C (Reason), D (Type of Expenditure), and G (Gross £).
- **Narrative (B)** = the merchant or short title that identifies the
  receipt itself (e.g. "McDonald's", "Pret A Manger", "Riverside").
- **Reason (C)** and **Type of Expenditure (D)** are both set to the chosen
  accounting category (e.g. "Subsistence"). They share a value because the
  spreadsheet's summary section uses column D for SUMIFS.
- Categories are a fixed list of 23 values (see `lib/categories.ts`) matched to
  the dropdown source in column J of the original spreadsheet. GPT-4o is
  constrained by JSON-schema enum to return one of them.
- The Net column (E) is a formula `=G-F` in the template, so it computes
  automatically. VAT (F) and Receipt-Held (A) are left blank for you to fill if
  needed.

## Replacing the template

If your form changes, drop the new file at
`templates/card-expenses-form.xlsx`. If the header row or column positions
change, update the constants at the top of [`lib/excel.ts`](lib/excel.ts).
