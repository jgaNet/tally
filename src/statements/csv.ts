import type { Statement } from './statements';

export const STATEMENT_CSV_HEADER = 'date,kind,id,description,paid,share,balance';

/** A field as CSV writes it: between double quotes, with each double quote doubled, when it needs them. */
function field(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The statement as CSV: a header line, then a line per entry, in the order of the statement. Every
 * line, the header's included, ends with CRLF.
 */
export function statementAsCsv(statement: Statement): string {
  const lines = [STATEMENT_CSV_HEADER];
  for (const entry of statement.entries) {
    const id = entry.kind === 'expense' ? entry.expenseId : entry.settlementId;
    lines.push(
      [entry.date, entry.kind, id, entry.description, entry.paid, entry.share, entry.balance]
        .map(value => field(String(value)))
        .join(','),
    );
  }
  return lines.map(line => `${line}\r\n`).join('');
}
