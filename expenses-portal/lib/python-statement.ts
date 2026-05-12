import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const PythonResultSchema = z.object({
  rows: z.array(
    z.object({
      transaction_date: z.string(),
      narrative: z.string(),
      gross: z.number(),
    }),
  ),
  expected_total: z.number().nullable().optional(),
  source: z.string().optional(),
  error: z.string().optional(),
  page_count: z.number().int().nonnegative().optional(),
  line_count_hint: z.number().optional(),
});

export type PythonStatementResult = z.infer<typeof PythonResultSchema>;

function pythonCandidates(): string[][] {
  const env = process.env.STATEMENT_PYTHON?.trim();
  if (env) return [[env]];
  if (process.platform === "win32") {
    return [["py", "-3"], ["python"], ["python3"]];
  }
  return [["python3"], ["python"]];
}

async function runPythonScript(
  scriptPath: string,
  pdfPath: string,
): Promise<string> {
  let lastErr: Error | null = null;
  for (const prefix of pythonCandidates()) {
    const argv = [...prefix, scriptPath, pdfPath];
    const [cmd, ...args] = argv;
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(cmd!, args, {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d: string) => {
          out += d;
        });
        child.stderr.on("data", (d: string) => {
          err += d;
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve(out);
          else reject(new Error(err || `Python exit ${code}`));
        });
      });
      return stdout;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.warn("[python-statement] try", cmd, ":", lastErr.message);
    }
  }
  throw lastErr ?? new Error("No working Python interpreter");
}

/**
 * Runs `scripts/parse_statement.py` on a PDF buffer. Returns empty rows if Python
 * or pymupdf is unavailable — caller should fall back to vision extraction.
 */
export async function runStatementPython(
  pdfBuffer: Buffer,
): Promise<PythonStatementResult> {
  const empty = (): PythonStatementResult => ({
    rows: [],
    expected_total: null,
    source: "unavailable",
  });

  const scriptPath = join(process.cwd(), "scripts", "parse_statement.py");
  const tmpPath = join(
    tmpdir(),
    `stmt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`,
  );

  try {
    await writeFile(tmpPath, pdfBuffer);
    const stdout = await runPythonScript(scriptPath, tmpPath);
    const trimmed = stdout.trim();
    if (!trimmed) {
      console.warn("[python-statement] empty stdout");
      return empty();
    }
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      console.warn("[python-statement] invalid JSON:", trimmed.slice(0, 200));
      return empty();
    }
    const parsed = PythonResultSchema.safeParse(json);
    if (!parsed.success) {
      console.warn("[python-statement] schema:", parsed.error.flatten());
      return empty();
    }
    if (parsed.data.error && parsed.data.rows.length === 0) {
      console.warn("[python-statement]", parsed.data.error);
    }
    return parsed.data;
  } catch (e) {
    console.warn("[python-statement]", e);
    return empty();
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
