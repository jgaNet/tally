import { MemberStatementView } from '@Contexts/Ledger/Application/History';

/** The header line of a statement as CSV (request 29): its columns, in this order. */
export const STATEMENT_CSV_HEADER = 'date,kind,id,description,paid,share,balance';

/**
 * One CSV field (RFC 4180): a field holding a comma, a double quote or a line break is written between double quotes, each double quote
 * in it doubled; any other field is written as it is.
 */
export function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * A member's statement as CSV (request 29): the header line, then one line for each entry in the statement's order, in UTF-8, each line
 * ending CRLF. An entry's `id` is its expense's or its settlement's. Rendered by the transport: the statement itself is the query's.
 */
export function statementAsCsv(statement: MemberStatementView): string {
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
  return [STATEMENT_CSV_HEADER, ...lines].map(line => `${line}\r\n`).join('');
}
