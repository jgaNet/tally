import type { Database } from '../database';
import { hasBeenMember } from '../groups/groups';
import { Refusal } from '../refusal';

/** What an expense does to a member's balance, as an entry of their statement. */
export interface ExpenseEntry {
  kind: 'expense';
  expenseId: string;
  date: string;
  description: string;
  /** What the member paid for it: its amount when they are its payer, 0 otherwise. */
  paid: number;
  /** The member's share of it: 0 when they are not in its split. */
  share: number;
  /** The member's balance once this entry is counted, starting from 0. */
  balance: number;
}

/** A settlement the balances count, as an entry of the statement of the member who paid it or was paid. */
export interface SettlementEntry {
  kind: 'settlement';
  settlementId: string;
  /** The day, in UTC, the balances started to count the settlement. */
  date: string;
  description: string;
  /** Its amount for its payer, 0 for its payee. */
  paid: number;
  /** Its amount for its payee, 0 for its payer. */
  share: number;
  /** The member's balance once this entry is counted, starting from 0. */
  balance: number;
}

export type StatementEntry = ExpenseEntry | SettlementEntry;

export interface Statement {
  memberId: string;
  /** The last entry's balance, or 0 when there is no entry: the balance the group's balances give. */
  balance: number;
  entries: StatementEntry[];
}

interface ExpenseRow {
  id: string;
  date: string;
  description: string;
  amount: number;
  paid_by: string;
  share: number | null;
  created_at: string;
  seq: number;
}

interface SettlementRow {
  id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: 'cash' | 'provider';
  counted_at: string;
  seq: number;
}

/** An entry with the keys it is put in order by: its date, when the balances started to count it, and its place of record. */
interface Ordered {
  date: string;
  at: string;
  kind: 'expense' | 'settlement';
  seq: number;
  entry: StatementEntry;
}

/**
 * The statement of `memberId` in `groupId`: every expense of the group, not deleted, that the member
 * paid or is in the split of, and every settlement of the group that the member paid or was paid and
 * that the balances count now (paid, or being refunded; a pending, failed or refunded one is left out).
 * They are in order of date, the earliest first; on the same date, the earliest first, an expense by
 * when it was recorded and a settlement by when the balances started to count it. Each entry carries
 * what the member paid and their share, and their running balance. Reading changes nothing.
 *
 * A member who has left keeps their statement. Refuses with `404` when `memberId` has never been a
 * member of the group.
 */
export function statementOf(db: Database, groupId: string, memberId: string): Statement {
  if (!hasBeenMember(db, groupId, memberId)) {
    throw new Refusal(404, 'NotFound', 'There is no such member in this group.');
  }

  // One statement, so it reads one snapshot of the file. A member has at most one share in an expense.
  const expenseRows = db
    .prepare(
      `SELECT expenses.id, expenses.date, expenses.description, expenses.amount, expenses.paid_by,
              expenses.created_at, expenses.rowid AS seq, expense_shares.amount AS share
         FROM expenses
         LEFT JOIN expense_shares
                ON expense_shares.expense_id = expenses.id AND expense_shares.member_id = ?
        WHERE expenses.group_id = ?
          AND (expenses.paid_by = ? OR expense_shares.member_id IS NOT NULL)`,
    )
    .all(memberId, groupId, memberId) as unknown as ExpenseRow[];

  // A settlement counts from the first time it was paid (its history's first `paid`), and stops counting
  // once it is refunded: the statuses the balances count are `paid` and `refunding`.
  const settlementRows = db
    .prepare(
      `SELECT settlements.id, settlements.payer_id, settlements.payee_id, settlements.amount,
              settlements.method, settlements.rowid AS seq,
              COALESCE((SELECT settlement_statuses.at
                          FROM settlement_statuses
                         WHERE settlement_statuses.settlement_id = settlements.id
                           AND settlement_statuses.status = 'paid'
                         ORDER BY settlement_statuses.id
                         LIMIT 1), settlements.created_at) AS counted_at
         FROM settlements
        WHERE settlements.group_id = ?
          AND (settlements.payer_id = ? OR settlements.payee_id = ?)
          AND settlements.status IN ('paid', 'refunding')`,
    )
    .all(groupId, memberId, memberId) as unknown as SettlementRow[];

  const ordered: Ordered[] = [
    ...expenseRows.map((row): Ordered => ({
      date: row.date,
      at: row.created_at,
      kind: 'expense',
      seq: row.seq,
      entry: {
        kind: 'expense',
        expenseId: row.id,
        date: row.date,
        description: row.description,
        paid: row.paid_by === memberId ? row.amount : 0,
        share: row.share ?? 0,
        balance: 0,
      },
    })),
    ...settlementRows.map((row): Ordered => ({
      date: row.counted_at.slice(0, 10),
      at: row.counted_at,
      kind: 'settlement',
      seq: row.seq,
      entry: {
        kind: 'settlement',
        settlementId: row.id,
        date: row.counted_at.slice(0, 10),
        description: row.method === 'cash' ? 'Settlement in cash' : 'Settlement through the provider',
        paid: row.payer_id === memberId ? row.amount : 0,
        share: row.payee_id === memberId ? row.amount : 0,
        balance: 0,
      },
    })),
  ];
  ordered.sort(
    (a, b) =>
      compare(a.date, b.date) ||
      compare(a.at, b.at) ||
      (a.kind === b.kind ? a.seq - b.seq : a.kind === 'expense' ? -1 : 1),
  );

  let balance = 0;
  const entries = ordered.map(({ entry }) => {
    balance += entry.paid - entry.share;
    return { ...entry, balance };
  });
  return { memberId, balance, entries };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
