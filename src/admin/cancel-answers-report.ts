import type Database from "better-sqlite3";

// api.md §4.4. What `critalarm cancel-answers` prints: the number of answers, a
// count per reason busiest first, then every answer with text, newest first.
// No account id, so the operator sees what people said and not who said it.
// The text goes inside JSON quotes, so a newline or a tab in it stays on one
// line and cannot pass for another column.
export function reportCancelAnswers(db: Database.Database, sinceSeconds?: number): string {
  const since = sinceSeconds === undefined ? [] : [sinceSeconds];
  const filter = sinceSeconds === undefined ? "" : "AND created_at >= ?";
  const counts = db
    .prepare(`SELECT reason, COUNT(*) AS count FROM cancel_answers WHERE 1 = 1 ${filter} GROUP BY reason ORDER BY count DESC, reason`)
    .all(...since) as { reason: string; count: number }[];
  const total = counts.reduce((sum, row) => sum + row.count, 0);
  const lines = [`${total} answers`, ...counts.map((row) => `${row.reason}\t${row.count}`)];
  const texts = db
    .prepare(`SELECT created_at, reason, platform, app_version, text FROM cancel_answers WHERE text IS NOT NULL ${filter} ORDER BY created_at DESC, reason`)
    .all(...since) as { created_at: number; reason: string; platform: string; app_version: string; text: string }[];
  if (texts.length > 0) {
    lines.push("");
    for (const row of texts) {
      const day = new Date(row.created_at * 1000).toISOString().slice(0, 10);
      lines.push(`${day}\t${row.reason}\t${row.platform}\t${row.app_version}\t${JSON.stringify(row.text)}`);
    }
  }
  return lines.join("\n");
}

// `--since YYYY-MM-DD`, read as midnight UTC of that day, in seconds. A date
// that does not exist (2026-02-31) is refused: Date.parse would roll it over
// into March, so the parsed day has to print back as the day given.
export function parseSinceDate(given: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(given)) return undefined;
  const ms = Date.parse(`${given}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== given) return undefined;
  return ms / 1000;
}
