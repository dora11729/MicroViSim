/**
 * CsvLineParser.ts
 *
 * Quote-aware CSV/TSV line splitting, shared by MetricsExtractor and K6CsvConverter
 * so a field containing the delimiter (e.g. an endpoint name with a comma) doesn't
 * silently shift every later column or get the whole row dropped by a column-count
 * mismatch check.
 *
 * Scope: single-line fields only — a quoted field is not expected to span multiple
 * physical lines, since both callers split the input into lines before parsing.
 */

/**
 * Splits one CSV/TSV line into fields, honoring double-quoted fields (including
 * an escaped `""` for a literal quote inside a quoted field) per RFC4180-style
 * conventions. A `delimiter` char inside quotes is treated as literal content,
 * not a field separator.
 */
export function parseCsvLine(line: string, delimiter: string = ","): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);

  return fields;
}
