import type { DatabaseSync } from 'node:sqlite';

/**
 * What a member of a group is owed (positive) or owes the group (negative): what they paid for the
 * group's expenses, minus their shares in them, over every expense of the group; plus what they paid
 * in settlements, minus what was paid to them.
 */
export interface Balance {
  readonly memberId: string;
  readonly balance: number;
}

interface BalanceRow {
  member_id: string;
  balance: number;
}

/**
 * The balance of every current member of a group, the earliest to join first (as {@link membersOfGroup}
 * orders them). A member who left is not among them. A member with no expense and no settlement has a
 * balance of 0. The balances add up to 0, since each expense's shares add up to its amount, each expense
 * is counted once, and each settlement moves its amount from its payee's balance to its payer's.
 *
 * It is one statement, so it reads one consistent state of the file: an expense recorded by another
 * server is either wholly counted or not at all. Reading never changes what is stored.
 */
export function balancesOfGroup(db: DatabaseSync, groupId: string): Balance[] {
  const rows = db
    .prepare(
      `SELECT m.account_id AS member_id,
              COALESCE((SELECT SUM(e.amount) FROM expenses e
                        WHERE e.group_id = m.group_id AND e.paid_by = m.account_id), 0)
              - COALESCE((SELECT SUM(s.amount) FROM expense_shares s
                          JOIN expenses e ON e.id = s.expense_id
                          WHERE e.group_id = m.group_id AND s.member_id = m.account_id), 0)
              + COALESCE((SELECT SUM(st.amount) FROM settlements st
                          WHERE st.group_id = m.group_id AND st.payer_id = m.account_id), 0)
              - COALESCE((SELECT SUM(st.amount) FROM settlements st
                          WHERE st.group_id = m.group_id AND st.payee_id = m.account_id), 0) AS balance
       FROM group_members m
       WHERE m.group_id = ? AND m.left_at IS NULL
       ORDER BY m.joined_at ASC, m.rowid ASC`,
    )
    .all(groupId) as unknown as BalanceRow[];
  return rows.map(row => ({ memberId: row.member_id, balance: Number(row.balance) }));
}
