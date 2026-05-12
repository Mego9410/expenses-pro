#!/usr/bin/env python3
"""
Parse UK-style credit-card statement PDFs that have a real text layer (not pure scans).

Outputs JSON to stdout: { "rows": [...], "expected_total": number | null, "source": "text" }

Rows: { "transaction_date", "narrative", "gross" } — no category (handled by AI in Node).

Exit 0 even when rows is empty (caller may fall back to vision). Exit 1 on I/O or JSON fatal.
"""
from __future__ import annotations

import json
import re
import sys
from typing import Any

try:
    import fitz  # PyMuPDF
except ImportError:
    print(
        json.dumps(
            {
                "rows": [],
                "expected_total": None,
                "source": "error",
                "error": "Missing pymupdf. Install: pip install pymupdf",
            }
        ),
        flush=True,
    )
    sys.exit(0)

MONTHS = (
    "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec",
)
DATE_START = re.compile(
    rf"^(\d{{1,2}}\s+(?:{MONTHS})[a-z]*\s+\d{{4}})\b",
    re.I,
)
AMOUNT_END = re.compile(r"([\d,]+\.\d{2})(CR)?\s*$", re.I)
SKIP_NARRATIVE = re.compile(
    r"^(previous balance|balance brought forward|opening balance|payment received|"
    r"payment\s*-\s*thank you|direct debit received|closing balance|new balance|"
    r"total payments due|amount due|total payments|total debits|total credits|"
    r"total of new transactions)\b",
    re.I,
)
TOTAL_PATTERNS = [
    re.compile(
        r"total\s+of\s+new\s+transactions[^\d£]*([\d,]+\.\d{2})",
        re.I,
    ),
    re.compile(
        r"total\s+payments[^\d£]*([\d,]+\.\d{2})",
        re.I,
    ),
    re.compile(
        r"total\s+debits\s+this\s+period[^\d£]*([\d,]+\.\d{2})",
        re.I,
    ),
]


def normalize_date(s: str) -> str:
    s = re.sub(r"\s+", " ", s.strip())
    m = re.match(r"^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$", s)
    if not m:
        return s
    day = int(m.group(1))
    mon_t = m.group(2).title()[:3]
    year = m.group(3)
    return f"{day} {mon_t} {year}"


def parse_amount_suffix(rest: str) -> tuple[float | None, str]:
    rest = rest.strip()
    m = AMOUNT_END.search(rest)
    if not m:
        return None, rest
    raw = m.group(1).replace(",", "")
    val = float(raw)
    if m.group(2):
        val = -val
    narrative = rest[: m.start()].strip()
    return val, narrative


def words_to_lines(page: fitz.Page, y_bucket: float = 3.0) -> list[str]:
    words = page.get_text("words")
    if not words:
        return []
    # (x0,y0,x1,y1, text, …) — sort by vertical band then x so line text reads left-to-right
    items: list[tuple[float, float, str]] = []
    for w in words:
        if len(w) < 5:
            continue
        x0, y0 = float(w[0]), float(w[1])
        t = str(w[4]).strip()
        if not t:
            continue
        y_key = round(y0 / y_bucket) * y_bucket
        items.append((y_key, x0, t))
    items.sort(key=lambda it: (it[0], it[1]))
    lines_map: dict[float, list[str]] = {}
    for y_key, _x0, t in items:
        lines_map.setdefault(y_key, []).append(t)
    out: list[str] = []
    for key in sorted(lines_map.keys()):
        parts = lines_map[key]
        line = " ".join(parts)
        if line.strip():
            out.append(line.strip())
    return out


def extract_rows_from_lines(lines: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None

    def flush() -> None:
        nonlocal cur
        if not cur:
            return
        g = cur.get("gross")
        n = (cur.get("narrative") or "").strip()
        if g is not None and n and not SKIP_NARRATIVE.match(n):
            rows.append(
                {
                    "transaction_date": cur["transaction_date"],
                    "narrative": n[:500],
                    "gross": round(float(g), 2),
                }
            )
        cur = None

    for line in lines:
        dm = DATE_START.match(line.strip())
        if dm:
            flush()
            date_raw = dm.group(1)
            rest = line[dm.end() :].strip()
            date_norm = normalize_date(date_raw)
            amt, narr = parse_amount_suffix(rest)
            if amt is not None:
                cur = {
                    "transaction_date": date_norm,
                    "narrative": narr or "(line item)",
                    "gross": amt,
                }
            else:
                cur = {
                    "transaction_date": date_norm,
                    "narrative": rest,
                    "gross": None,
                }
            continue
        if cur is not None and cur.get("gross") is None:
            amt, narr = parse_amount_suffix(line)
            if amt is not None:
                prev = cur["narrative"] or ""
                cur["narrative"] = (prev + " " + narr).strip()
                cur["gross"] = amt
            else:
                cur["narrative"] = (cur["narrative"] + " " + line.strip()).strip()

    flush()
    return rows


def find_expected_total(text: str) -> float | None:
    best: float | None = None
    for pat in TOTAL_PATTERNS:
        for m in pat.finditer(text):
            try:
                v = float(m.group(1).replace(",", ""))
                best = v
            except ValueError:
                continue
    return best


def main() -> None:
    if len(sys.argv) < 2:
        print(
            json.dumps(
                {
                    "rows": [],
                    "expected_total": None,
                    "source": "error",
                    "error": "Usage: parse_statement.py <path-to.pdf>",
                }
            ),
            flush=True,
        )
        sys.exit(1)

    path = sys.argv[1]
    try:
        doc = fitz.open(path)
    except Exception as e:
        print(
            json.dumps(
                {
                    "rows": [],
                    "expected_total": None,
                    "source": "error",
                    "error": str(e),
                }
            ),
            flush=True,
        )
        sys.exit(0)

    all_lines: list[str] = []
    full_text_parts: list[str] = []
    page_count = doc.page_count
    try:
        for page in doc:
            full_text_parts.append(page.get_text("text") or "")
            all_lines.extend(words_to_lines(page))
    finally:
        doc.close()

    full_text = "\n".join(full_text_parts)
    expected = find_expected_total(full_text)

    rows = extract_rows_from_lines(all_lines)
    # If word-position lines produced nothing, try raw text lines
    if not rows:
        raw_lines = [ln.strip() for ln in full_text.splitlines() if ln.strip()]
        rows = extract_rows_from_lines(raw_lines)

    out = {
        "rows": rows,
        "expected_total": expected,
        "source": "text",
        "page_count": page_count,
        "line_count_hint": len(all_lines),
    }
    print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
