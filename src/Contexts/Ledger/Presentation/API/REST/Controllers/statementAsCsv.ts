import { StatementReadModel } from '@Contexts/Ledger/Application/ReadModel/StatementReadModel';

/** The columns of a statement as CSV, in this order (request 29). */
const HEADER = 'date,kind,id,description,paid,share,balance';

/**
 * A member's statement as CSV (request 29): a header line, then one line per entry in the statement's order, each ending in
 * CRLF. A field holding a comma, a double quote or a line break is written between double quotes, each double quote in it
 * doubled; no other field is quoted.
 */
export function statementAsCsv(statement: StatementReadModel): string {
  const lines = statement.entries.map(entry =>
    [
      entry.date,
      entry.kind,
      entry.kind === 'expense' ? entry.expenseId : entry.settlementId,
      entry.description,
      entry.paid,
      entry.share,
      entry.balance,
    ]
      .map(csvField)
      .join(','),
  );
  return [HEADER, ...lines].map(line => `${line}\r\n`).join('');
}

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
