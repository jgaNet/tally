import { StatementEntryView, StatementView } from '@Contexts/Ledger/Domain/Expense/DTOs';

/** The header line of a member's statement as CSV, its columns in the order request 29 gives (docs/adr/0028). */
export const STATEMENT_CSV_HEADER = 'date,kind,id,description,paid,share,balance';

/**
 * A field of a CSV line: written between double quotes, each double quote in it doubled, when it holds a comma, a double quote or a
 * line break; no other field is quoted (request 29).
 */
function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The entry's id: the expense's, or the settlement's. */
const idOf = (entry: StatementEntryView): string => (entry.kind === 'expense' ? entry.expenseId : entry.settlementId);

/**
 * A member's statement as CSV (request 29, docs/adr/0028): the header line, then one line per entry in the statement's order, each
 * line ended by CRLF. The rendering is the transport's: the read model is the statement, as the JSON answers it.
 */
export function statementAsCsv(statement: StatementView): string {
  const lines = [
    STATEMENT_CSV_HEADER,
    ...statement.entries.map(entry =>
      [entry.date, entry.kind, idOf(entry), entry.description, entry.paid, entry.share, entry.balance]
        .map(csvField)
        .join(','),
    ),
  ];
  return lines.map(line => `${line}\r\n`).join('');
}
