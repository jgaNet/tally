import type { Querier } from './database';

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
  is_current: boolean;
  is_owner: boolean;
  balance: number;
}

export interface BalanceOptions {
  /**
   * When true, a settlement waiting at the payment provider counts as if it were paid: what is still
   * owed is what is owed less what is waiting to be paid. Off by default: the group's balances count a
   * settlement once it is paid, and not before.
   */
  readonly includePending?: boolean;
}

/**
 * The statuses of the settlements that count, as a constant chosen here, never a value from a request.
 */
function countedStatuses(options: BalanceOptions): string {
  return options.includePending ? `'paid', 'refunding', 'pending'` : `'paid', 'refunding'`;
}

/**
 * What the account of the membership `m` of a group is owed (positive) or owes (negative) from the group's
 * expenses and settlements, over all of them, as it was counted from the start: the balance before any
 * amount has been passed on (see {@link balancesOfGroup}).
 */
function rawBalanceSql(counted: string): string {
  return `COALESCE((SELECT SUM(e.amount) FROM expenses e
                    WHERE e.group_id = m.group_id AND e.paid_by = m.account_id), 0)
          - COALESCE((SELECT SUM(s.amount) FROM expense_shares s
                      JOIN expenses e ON e.id = s.expense_id
                      WHERE e.group_id = m.group_id AND s.member_id = m.account_id), 0)
          + COALESCE((SELECT SUM(st.amount) FROM settlements st
                      WHERE st.group_id = m.group_id AND st.payer_id = m.account_id
                        AND st.status IN (${counted})), 0)
          - COALESCE((SELECT SUM(st.amount) FROM settlements st
                      WHERE st.group_id = m.group_id AND st.payee_id = m.account_id
                        AND st.status IN (${counted})), 0)`;
}

/**
 * The raw balance of `accountId` in the group, counting the group's settlements that are paid (see
 * {@link balancesOfGroup}), over every expense of the group, as {@link rawBalanceSql} counts it. It is 0 for
 * an account that has no membership of the group. Reading changes nothing.
 */
export async function rawBalanceOf(db: Querier, groupId: string, accountId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT ${rawBalanceSql(countedStatuses({}))} AS balance FROM group_members m
       WHERE m.group_id = ? AND m.account_id = ?`,
    )
    .get<{ balance: number }>(groupId, accountId);
  return row === undefined ? 0 : Number(row.balance);
}

/**
 * The balance of the membership of `accountId` in the group, current or left, as {@link balancesOfGroup} counts it: its
 * raw balance less what it has passed on. It is 0 for an account with no membership of the group. Reading changes nothing.
 */
export async function balanceOfMembership(db: Querier, groupId: string, accountId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT (${rawBalanceSql(countedStatuses({}))}) - m.balance_base AS balance FROM group_members m
       WHERE m.group_id = ? AND m.account_id = ?`,
    )
    .get<{ balance: number }>(groupId, accountId);
  return row === undefined ? 0 : Number(row.balance);
}

/**
 * The balance of every current member of a group, the earliest to join first (as {@link membersOfGroup}
 * orders them). A member with no expense and no settlement has a balance of 0. The balances add up to 0,
 * since each expense's shares add up to its amount, each expense is counted once, and each settlement
 * moves its amount from its payee's balance to its payer's.
 *
 * A member who left passes their balance to the group's owner: it is not among the balances, and the owner's
 * balance is the owner's own plus the balances of the members who left. So the owner's balance changes in the same
 * step as the member leaves. Each membership keeps a `balance_base`, the part of its raw balance already passed on:
 * a member's balance is its raw balance less that base. A member who joins again has its raw balance as base, so
 * starts at 0, and what it had passed on stays with the owner (see `acceptInvitation`).
 *
 * A settlement counts once it is `paid`, and goes on counting while it is `refunding`, since the money has not
 * gone back yet; a `refunded`, `failed` one never counts. With `includePending`, a `pending` one counts too, as
 * if paid.
 *
 * It is one statement, so it reads one consistent state of the database: an expense recorded by another
 * server is either wholly counted or not at all. Reading never changes what is stored.
 */
export async function balancesOfGroup(db: Querier, groupId: string, options: BalanceOptions = {}): Promise<Balance[]> {
  const rows = await db
    .prepare(
      `SELECT m.account_id AS member_id,
              m.left_at IS NULL AS is_current,
              g.owner_id = m.account_id AS is_owner,
              (${rawBalanceSql(countedStatuses(options))}) - m.balance_base AS balance
       FROM group_members m
       JOIN groups g ON g.id = m.group_id
       WHERE m.group_id = ?
       ORDER BY m.joined_at ASC, m.seq ASC`,
    )
    .all<BalanceRow>(groupId);
  // What members who left still hold passes to the owner, who is always a current member.
  const passedOn = rows.filter(row => !row.is_current).reduce((total, row) => total + Number(row.balance), 0);
  return rows
    .filter(row => row.is_current)
    .map(row => ({
      memberId: row.member_id,
      balance: Number(row.balance) + (row.is_owner ? passedOn : 0),
    }));
}
