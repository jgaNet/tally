import { MemberStatement } from '@Contexts/Ledger/Domain/Expense/Ports/IStatementQueries';

/**
 * A member's statement as CSV (request 29): a header line, then one line per entry in the statement's order, `date,kind,id,
 * description,paid,share,balance`, UTF-8 text with CRLF line endings. A field holding a comma, a double quote or a line break is
 * written between double quotes, each double quote in it doubled; no other field is quoted.
 */
export function statementCsv(statement: MemberStatement): string {
  const lines: (string | number)[][] = [['date', 'kind', 'id', 'description', 'paid', 'share', 'balance']];
  for (const entry of statement.entries) {
    const id = entry.kind === 'expense' ? entry.expenseId : entry.settlementId;
    lines.push([entry.date, entry.kind, id, entry.description, entry.paid, entry.share, entry.balance]);
  }
  return lines.map(line => line.map(csvField).join(',') + '\r\n').join('');
}

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
