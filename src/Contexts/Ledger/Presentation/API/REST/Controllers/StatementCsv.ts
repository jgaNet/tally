import { StatementEntryReadModel, StatementReadModel } from '@Contexts/Ledger/Application/ReadModel/StatementReadModel';

/** The columns of a statement as CSV, in this order (request 29). */
export const STATEMENT_CSV_HEADER = 'date,kind,id,description,paid,share,balance';

/**
 * A member's statement as CSV, in UTF-8 (request 29): the header line, then one line per entry in the statement's order. Lines end
 * with CRLF. A field holding a comma, a double quote or a line break is written between double quotes, each double quote in it
 * doubled; no other field is quoted.
 */
export function renderStatementCsv(statement: StatementReadModel): string {
  return [STATEMENT_CSV_HEADER, ...statement.entries.map(csvLine)].map(line => `${line}\r\n`).join('');
}

const csvLine = (entry: StatementEntryReadModel): string =>
  [
    entry.date,
    entry.kind,
    entry.kind === 'expense' ? entry.expenseId : entry.settlementId,
    entry.description,
    entry.paid,
    entry.share,
    entry.balance,
  ]
    .map(field)
    .join(',');

const field = (value: string | number): string => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
