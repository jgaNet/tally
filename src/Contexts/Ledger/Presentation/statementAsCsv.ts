import { StatementEntryView, StatementView } from '@Contexts/Ledger/Application/IStatementQueries';

/** The header line of the statement as CSV, its columns in this order (request 29). */
const HEADER = ['date', 'kind', 'id', 'description', 'paid', 'share', 'balance'];

/**
 * A member's statement, rendered as CSV (request 29): a header line, then one line for each entry in the order of the statement. Each line
 * ends with CRLF, the last one too. A field holding a comma, a double quote or a line break is written between double quotes, each double
 * quote in it doubled; no other field is quoted. `id` is the expense's or the settlement's.
 */
export const statementAsCsv = (statement: StatementView): string =>
  [HEADER, ...statement.entries.map(lineOf)].map(fields => `${fields.map(field).join(',')}\r\n`).join('');

/** The fields of an entry, in the columns' order. */
const lineOf = (entry: StatementEntryView): (string | number)[] => [
  entry.date,
  entry.kind,
  entry.kind === 'expense' ? entry.expenseId : entry.settlementId,
  entry.description,
  entry.paid,
  entry.share,
  entry.balance,
];

/** A field as CSV writes it: quoted, with its double quotes doubled, when it holds a comma, a double quote or a line break. */
const field = (value: string | number): string => {
  const text = String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
