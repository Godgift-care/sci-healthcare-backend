/**
 * Minimal RFC 4180 CSV writing, used by the streamed voucher export.
 *
 * Only one cell at a time is escaped and appended, so an export never has
 * to hold the whole document in memory.
 */

/**
 * Escapes one cell: quote it only when it contains a delimiter, quote or line
 * break.
 *
 * A cell a spreadsheet would evaluate as a formula is prefixed with an
 * apostrophe first, so a clinic name or any other stored string cannot turn a
 * download into a formula when the file is opened in Excel or Sheets. This is
 * the CSV-injection guard, applied to every export that uses this writer.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          typeof value === 'bigint'
        ? String(value)
        : JSON.stringify(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  if (!/[",\r\n]/.test(safe)) return safe;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}
