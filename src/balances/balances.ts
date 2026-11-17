import type { Database } from '../database';

export interface Balance {
  memberId: string;
  /**
   * What the member paid for the group's expenses, minus their shares in them, in hundredths of
   * the group's currency. Positive: the group owes them. Negative: they owe the group.
   */
  balance: number;
}

interface BalanceRow {
  member_id: string;
  balance: number;
}

/**
 * The balance of every member of `groupId`, the earliest to join first (the same order as the
 * members). A member with nothing recorded and in no split has a balance of 0.
 *
 * It is one statement, so it reads one snapshot of the file: an expense is either wholly in the
 * balances or not at all. Each expense's shares add up to its amount, so the balances always add
 * up to 0. Reading changes nothing.
 */
export function balancesOf(db: Database, groupId: string): Balance[] {
  const rows = db
    .prepare(
      `SELECT memberships.account_id AS member_id,
              (SELECT COALESCE(SUM(expenses.amount), 0)
                 FROM expenses
                WHERE expenses.group_id = memberships.group_id
                  AND expenses.paid_by = memberships.account_id)
            - (SELECT COALESCE(SUM(expense_shares.amount), 0)
                 FROM expense_shares
                 JOIN expenses ON expenses.id = expense_shares.expense_id
                WHERE expenses.group_id = memberships.group_id
                  AND expense_shares.member_id = memberships.account_id) AS balance
         FROM memberships
        WHERE memberships.group_id = ?
        ORDER BY memberships.joined_at, memberships.rowid`,
    )
    .all(groupId) as unknown as BalanceRow[];
  return rows.map(row => ({ memberId: row.member_id, balance: Number(row.balance) }));
}
