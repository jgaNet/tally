import type { Database } from '../database';

export interface Balance {
  memberId: string;
  /**
   * What the member paid for the group's expenses, minus their shares in them, plus what they paid
   * in settlements, minus what they were paid in settlements, plus what was passed on to them when a
   * member left, minus what they passed on when they left, in the minor unit of the group's currency.
   * Positive: the group owes them. Negative: they owe the group.
   */
  balance: number;
}

interface BalanceRow {
  member_id: string;
  balance: number;
}

/**
 * The balance of every member of `groupId`, the earliest to join first (the same order as the
 * members). A member with nothing recorded and in no split has a balance of 0. Only a settlement that
 * is paid counts, or one being refunded, which still counts until the provider says it is refunded:
 * one waiting at the provider, one the provider failed, one refunded, or one contested (held until an
 * administrator decides it), does not move a balance. A settlement moves what it settles: its amount, less the part
 * of the provider's fee its payer bears.
 *
 * It is one statement, so it reads one snapshot of the file: an expense is either wholly in the
 * balances or not at all. Each expense's shares add up to its amount, so the balances always add
 * up to 0, and so do the transfers made when members left, which each move a balance from the one who
 * left to the owner. Reading changes nothing.
 */
export function balancesOf(db: Database, groupId: string): Promise<Balance[]> {
  return balancesCounting(db, groupId, `settlements.status IN ('paid', 'refunding')`);
}

/**
 * The balances as if every settlement that has not failed, been refunded or been annulled were paid: a
 * settlement waiting at the provider, or contested, counts as paid, as it still waits. What a member
 * still owes, or is still owed, is read from these. Reading changes nothing.
 */
export function balancesWithPendingOf(db: Database, groupId: string): Promise<Balance[]> {
  return balancesCounting(db, groupId, `settlements.status IN ('pending', 'paid', 'refunding', 'contested')`);
}

/** `counted` is a condition on `settlements`, written here and never from a request. */
async function balancesCounting(db: Database, groupId: string, counted: string): Promise<Balance[]> {
  const rows = await db.rows<BalanceRow>(
    `SELECT memberships.account_id AS member_id,
              (SELECT COALESCE(SUM(expenses.amount), 0)
                 FROM expenses
                WHERE expenses.group_id = memberships.group_id
                  AND expenses.paid_by = memberships.account_id)
            - (SELECT COALESCE(SUM(expense_shares.amount), 0)
                 FROM expense_shares
                 JOIN expenses ON expenses.id = expense_shares.expense_id
                WHERE expenses.group_id = memberships.group_id
                  AND expense_shares.member_id = memberships.account_id)
            + (SELECT COALESCE(SUM(settlements.settled_amount), 0)
                 FROM settlements
                WHERE settlements.group_id = memberships.group_id
                  AND settlements.payer_id = memberships.account_id
                  AND ${counted})
            - (SELECT COALESCE(SUM(settlements.settled_amount), 0)
                 FROM settlements
                WHERE settlements.group_id = memberships.group_id
                  AND settlements.payee_id = memberships.account_id
                  AND ${counted})
            + (SELECT COALESCE(SUM(balance_transfers.amount), 0)
                 FROM balance_transfers
                WHERE balance_transfers.group_id = memberships.group_id
                  AND balance_transfers.to_id = memberships.account_id)
            - (SELECT COALESCE(SUM(balance_transfers.amount), 0)
                 FROM balance_transfers
                WHERE balance_transfers.group_id = memberships.group_id
                  AND balance_transfers.from_id = memberships.account_id) AS balance
         FROM memberships
        WHERE memberships.group_id = ?
        ORDER BY memberships.joined_at, memberships.seq`,
    [groupId],
  );
  return rows.map(row => ({ memberId: row.member_id, balance: Number(row.balance) }));
}
