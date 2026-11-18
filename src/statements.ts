import type { Database } from './database';
import { type FeeBearer, settledOfRow } from './fees';
import { findGroupOfMember, isOrWasMember } from './groups';
import { Refusal } from './refusal';
import { inReadSnapshot } from './transactions';

/** The kind of an entry of a statement: an expense, or a settlement the balances count. */
export type StatementEntryKind = 'expense' | 'settlement';

interface StatementEntryFields {
  /** The day the entry is dated, `YYYY-MM-DD`, in UTC for a settlement (the day the balances started to count it). */
  readonly date: string;
  readonly description: string;
  /** What the member paid for the entry: the expense's amount for its payer, the settlement's for its payer. */
  readonly paid: number;
  /** What the member owes for the entry: their share of the expense, the settlement's amount for its payee. */
  readonly share: number;
  /** The member's balance once the entry is counted, starting from 0. */
  readonly balance: number;
}

/** An expense in a member's statement: `paid` and `share` as the expense gives them. */
export interface ExpenseStatementEntry extends StatementEntryFields {
  readonly kind: 'expense';
  readonly expenseId: string;
}

/** A settlement the balances count, in a member's statement: `paid` for its payer, `share` for its payee. */
export interface SettlementStatementEntry extends StatementEntryFields {
  readonly kind: 'settlement';
  readonly settlementId: string;
}

export type StatementEntry = ExpenseStatementEntry | SettlementStatementEntry;

/**
 * A member's statement: every expense of the group, not deleted, that the member paid or is in the split
 * of, and every settlement the member paid or was paid that the balances count, in the order of a bank
 * statement: the earliest date first, then the earliest counted. An expense is counted when it is recorded,
 * a settlement when the balances start to count it (see {@link statementOfMember}). `balance` is the last
 * entry's, or 0 with no entry, which is the member's balance in the group.
 */
export interface Statement {
  readonly memberId: string;
  readonly balance: number;
  readonly entries: readonly StatementEntry[];
}

interface ExpenseRow {
  id: string;
  spent_on: string;
  description: string;
  amount: number;
  paid_by: string;
  created_at: string;
  share: number | null;
}

interface SettlementRow {
  id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  fee_amount: number | null;
  fee_borne_by: FeeBearer | null;
  method: 'cash' | 'provider' | 'net';
  counted_at: string;
}

/** What a settlement's entry says of it, by the method it was made by. */
const SETTLEMENT_DESCRIPTIONS: Record<SettlementRow['method'], string> = {
  cash: 'Settlement in cash',
  provider: 'Settlement through the provider',
  net: 'Settlement by netting',
};

/** An entry before its balance is known: what it is, when it is counted, and what it moves. */
interface CountedEntry {
  readonly kind: StatementEntryKind;
  readonly id: string;
  readonly date: string;
  /** The instant the balances started to count it: an expense's recording, a settlement's first `paid`. */
  readonly at: string;
  readonly description: string;
  readonly paid: number;
  readonly share: number;
}

/** The order of a statement: the earlier date first, then the earlier instant; a tie keeps the order it came in. */
function byDateThenInstant(a: CountedEntry, b: CountedEntry): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return 0;
}

/**
 * The statement of `memberId` in the group, read by `readerId`, who must be a current member of the group
 * (else `404`, as if the group did not exist). `memberId` must be a member of the group, or have left it (else `404`).
 *
 * A settlement is counted as the balances count it (see `balances.ts`): a cash one from when it is recorded, a
 * provider one from when it is paid until it is refunded. So a `pending`, `failed`, `refunded`, `contested` or `annulled`
 * settlement is left out, and a `refunding` one is listed, since the money has not gone back yet. Its date is the UTC day of
 * the first `paid` in its history. It reads one consistent state of the database and changes nothing.
 */
export async function statementOfMember(
  db: Database,
  readerId: string,
  groupId: string,
  memberId: string,
): Promise<Statement> {
  return inReadSnapshot(db, async snapshot => {
    if (!(await findGroupOfMember(snapshot, readerId, groupId))) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    // A member who left keeps a statement, read by the group's current members.
    if (!(await isOrWasMember(snapshot, memberId, groupId))) {
      throw new Refusal(404, 'MemberNotFound', 'No member of the group has this id.');
    }
    // The share is joined on the member alone, so each expense appears once: a member is listed once in a split.
    const expenseRows = await snapshot
      .prepare(
        `SELECT e.id, e.spent_on, e.description, e.amount, e.paid_by, e.created_at, s.amount AS share
         FROM expenses e
         LEFT JOIN expense_shares s ON s.expense_id = e.id AND s.member_id = ?
         WHERE e.group_id = ? AND (e.paid_by = ? OR s.member_id IS NOT NULL)
         ORDER BY e.spent_on ASC, e.created_at ASC, e.seq ASC`,
      )
      .all<ExpenseRow>(memberId, groupId, memberId);
    // Counted as the balances count them: paid, or refunding (not yet given back), and not refunded.
    const settlementRows = await snapshot
      .prepare(
        `SELECT st.id, st.payer_id, st.payee_id, st.amount, st.fee_amount, st.fee_borne_by, st.method,
                COALESCE((SELECT MIN(h.at) FROM settlement_statuses h
                          WHERE h.settlement_id = st.id AND h.status = 'paid'), st.created_at) AS counted_at
         FROM settlements st
         WHERE st.group_id = ? AND (st.payer_id = ? OR st.payee_id = ?) AND st.status IN ('paid', 'refunding')
         ORDER BY counted_at ASC, st.seq ASC`,
      )
      .all<SettlementRow>(groupId, memberId, memberId);

    const counted: CountedEntry[] = [
      ...expenseRows.map((row): CountedEntry => ({
        kind: 'expense',
        id: row.id,
        date: row.spent_on,
        at: row.created_at,
        description: row.description,
        paid: row.paid_by === memberId ? Number(row.amount) : 0,
        share: row.share === null ? 0 : Number(row.share),
      })),
      ...settlementRows.map((row): CountedEntry => ({
        kind: 'settlement',
        id: row.id,
        // The instant is in UTC, so its day is the UTC day. What it moves is what it settles (see `fees.ts`).
        date: row.counted_at.slice(0, 10),
        at: row.counted_at,
        description: SETTLEMENT_DESCRIPTIONS[row.method],
        paid: row.payer_id === memberId ? settledOfRow(row) : 0,
        share: row.payee_id === memberId ? settledOfRow(row) : 0,
      })),
    ];
    // A stable sort: an expense and a settlement counted at the same instant keep the expense first.
    counted.sort(byDateThenInstant);

    let balance = 0;
    const entries = counted.map((entry): StatementEntry => {
      balance += entry.paid - entry.share;
      const fields = {
        date: entry.date,
        description: entry.description,
        paid: entry.paid,
        share: entry.share,
        balance,
      };
      return entry.kind === 'expense'
        ? { kind: 'expense', expenseId: entry.id, ...fields }
        : { kind: 'settlement', settlementId: entry.id, ...fields };
    });
    return { memberId, balance, entries };
  });
}

/** A CSV field: quoted, with each double quote doubled, when it holds a comma, a double quote or a line break. */
function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The statement as CSV, in UTF-8: a header line, then one line for each entry in the statement's order, each
 * ending CRLF. The columns are `date,kind,id,description,paid,share,balance`, with `id` the expense's or the
 * settlement's.
 */
export function statementAsCsv(statement: Statement): string {
  const lines: (string | number)[][] = [
    ['date', 'kind', 'id', 'description', 'paid', 'share', 'balance'],
    ...statement.entries.map(entry => [
      entry.date,
      entry.kind,
      entry.kind === 'expense' ? entry.expenseId : entry.settlementId,
      entry.description,
      entry.paid,
      entry.share,
      entry.balance,
    ]),
  ];
  return lines.map(line => `${line.map(csvField).join(',')}\r\n`).join('');
}
