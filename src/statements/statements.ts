import type { Database } from '../database';
import { Refusal } from '../refusal';

export interface StatementEntry {
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

export interface Statement {
  memberId: string;
  /** The last entry's balance, or 0 when there is no entry: the balance the group's balances give. */
  balance: number;
  entries: StatementEntry[];
}

interface StatementRow {
  id: string;
  date: string;
  description: string;
  amount: number;
  paid_by: string;
  share: number | null;
}

/**
 * The statement of `memberId` in `groupId`: every expense of the group, not deleted, that the member
 * paid or is in the split of, the earliest date first, then the earliest recorded first. Each entry
 * carries what the member paid and their share, and their running balance. Reading changes nothing.
 *
 * Refuses with `404` when `memberId` has never been a member of the group.
 */
export function statementOf(db: Database, groupId: string, memberId: string): Statement {
  const member = db.prepare('SELECT 1 FROM memberships WHERE group_id = ? AND account_id = ?').get(groupId, memberId);
  if (member === undefined) {
    throw new Refusal(404, 'NotFound', 'There is no such member in this group.');
  }

  // One statement, so it reads one snapshot of the file. A member has at most one share in an expense.
  const rows = db
    .prepare(
      `SELECT expenses.id, expenses.date, expenses.description, expenses.amount, expenses.paid_by,
              expense_shares.amount AS share
         FROM expenses
         LEFT JOIN expense_shares
                ON expense_shares.expense_id = expenses.id AND expense_shares.member_id = ?
        WHERE expenses.group_id = ?
          AND (expenses.paid_by = ? OR expense_shares.member_id IS NOT NULL)
        ORDER BY expenses.date, expenses.created_at, expenses.rowid`,
    )
    .all(memberId, groupId, memberId) as unknown as StatementRow[];

  let balance = 0;
  const entries = rows.map(row => {
    const paid = row.paid_by === memberId ? row.amount : 0;
    const share = row.share ?? 0;
    balance += paid - share;
    return { expenseId: row.id, date: row.date, description: row.description, paid, share, balance };
  });
  return { memberId, balance, entries };
}
