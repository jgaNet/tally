import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from './database';
import { findGroupOf } from './groups';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

export interface Balance {
  memberId: string;
  balance: number;
}

/** A membership of the group as the one statement reads it: its raw balance, before offsets and carried balances. */
interface MembershipRow {
  member_id: string;
  active: number;
  balance_offset: number;
  owner_id: string;
  raw: number;
}

/**
 * The statuses a balance counts, as the SQL list of them, written here and never from input. A contested settlement is counted
 * by neither: the balances are as they were before it was paid, until an administrator decides it.
 */
type CountedStatuses = "('paid', 'refunding')" | "('paid', 'pending', 'refunding', 'contested')";

/**
 * The balances of the group now, in the order its members joined, the earliest first. A member's balance is
 * what they paid for the group's expenses, minus their shares in them, plus what their settlements take, less
 * what is paid to them; less their offset, the balance a membership carries away (see `balance_offset`). Positive
 * when the group owes them, negative when they owe the group, 0 when they are even.
 *
 * The owner of the group takes over the balances of the members who have left it: what a member who left owed
 * or was owed is in the owner's balance, from the moment they left, and it stays there as the balances of the
 * group change. So the balances of the group's members always add up to 0, whatever the balances are when a
 * member leaves, and whatever a settlement later does for a member who has left.
 *
 * A settlement counts once it is paid: a cash settlement from the moment it is recorded, one through the
 * provider once the provider says it succeeded. It keeps counting while it is being refunded, as the money has
 * not gone back yet; once it is refunded it counts for nothing. What it counts is what it settles (see
 * `Settlement.settled`): its amount, less the part of the provider's fee its payer bears.
 *
 * It is one statement, so every balance is of the same snapshot of the database: an expense or a settlement
 * recorded meanwhile is counted in all of them or in none. A read changes nothing.
 */
export function listBalances(db: Queryable, groupId: string): Promise<Balance[]> {
  return balancesCounting(db, groupId, "('paid', 'refunding')");
}

/**
 * The balances as they stand once the payments waiting at the provider are counted as paid: what each
 * member still owes, or is still owed, is what their balance gives, less what is waiting to be paid by
 * them, or to them. It is what a new settlement is decided on, and what the suggested settlements are made
 * from. The balances still add up to 0. A read changes nothing.
 */
export function listBalancesIncludingWaiting(db: Queryable, groupId: string): Promise<Balance[]> {
  return balancesCounting(db, groupId, "('paid', 'pending', 'refunding', 'contested')");
}

/**
 * The memberships of the group, the members who have left included, each with its raw balance: what its expenses and
 * settlements give, counting the settlements whose status is one of `statuses`. Every membership is read in
 * the one statement, so they are of one snapshot of the database. The raw balances of a group add up to 0.
 */
function membershipsOf(db: Queryable, groupId: string, statuses: CountedStatuses): Promise<MembershipRow[]> {
  return db.all<MembershipRow>(
    `SELECT m.account_id AS member_id, CASE WHEN m.left_at IS NULL THEN 1 ELSE 0 END AS active, m.balance_offset, g.owner_id,
         COALESCE((SELECT SUM(e.amount) FROM expenses e
                   WHERE e.group_id = m.group_id AND e.paid_by = m.account_id), 0)
         - COALESCE((SELECT SUM(s.amount) FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
                     WHERE e.group_id = m.group_id AND s.account_id = m.account_id), 0)
         + COALESCE((SELECT SUM(t.settled) FROM settlements t
                     WHERE t.group_id = m.group_id AND t.payer_id = m.account_id AND t.status IN ${statuses}), 0)
         - COALESCE((SELECT SUM(t.settled) FROM settlements t
                     WHERE t.group_id = m.group_id AND t.payee_id = m.account_id AND t.status IN ${statuses}), 0) AS raw
       FROM group_members m JOIN groups g ON g.id = m.group_id
       WHERE m.group_id = ?
       ORDER BY m.joined_order`,
    [groupId],
  );
}

/**
 * The balance a member carries as they stand in the group, as `listBalances` counts it: what their expenses and
 * settlements give, less their offset. It is what the owner takes over when the member leaves. 0 for an account that
 * is not a member of the group. A read changes nothing.
 */
export async function carriedBalanceOf(db: Queryable, groupId: string, accountId: string): Promise<number> {
  const row = (await membershipsOf(db, groupId, "('paid', 'refunding')")).find(
    membership => membership.member_id === accountId,
  );
  return row ? row.raw - row.balance_offset : 0;
}

/** The balances, counting the settlements whose status is one of `statuses`. */
async function balancesCounting(db: Queryable, groupId: string, statuses: CountedStatuses): Promise<Balance[]> {
  const memberships = await membershipsOf(db, groupId, statuses);
  const ownerId = memberships[0]?.owner_id;
  // What the members who have left carry to the owner: what each one's balance is, less its offset.
  const carried = memberships
    .filter(row => row.active === 0 && row.member_id !== ownerId)
    .reduce((sum, row) => sum + row.raw - row.balance_offset, 0);
  return memberships
    .filter(row => row.active === 1)
    .map(row => ({
      memberId: row.member_id,
      balance: row.raw - row.balance_offset + (row.member_id === ownerId ? carried : 0),
    }));
}

/**
 * Starts a member who joins again at a balance of 0, as they are a member from that moment. The offset of the
 * member becomes what their raw balance is, and the owner's offset moves by the opposite, so the owner keeps
 * what passed to them when the member left. The balances of the group are the same after the join as before it,
 * except for the joining member, at 0. Called in the write transaction that joins the account to the group; it
 * changes nothing for an account that never was a member, as its raw balance is 0.
 */
export async function resetBalanceOnRejoin(db: Queryable, groupId: string, accountId: string): Promise<void> {
  const row = (await membershipsOf(db, groupId, "('paid', 'refunding')")).find(
    membership => membership.member_id === accountId,
  );
  if (!row) return;
  const change = row.raw - row.balance_offset;
  if (change === 0) return;
  await db.run('UPDATE group_members SET balance_offset = balance_offset + ? WHERE group_id = ? AND account_id = ?', [
    change,
    groupId,
    accountId,
  ]);
  await db.run('UPDATE group_members SET balance_offset = balance_offset - ? WHERE group_id = ? AND account_id = ?', [
    change,
    groupId,
    row.owner_id,
  ]);
}

const balanceSchema = {
  type: 'object',
  required: ['memberId', 'balance'],
  properties: { memberId: { type: 'string' }, balance: { type: 'integer' } },
};

/** The balances are read by the members of the group. For anyone else the group does not exist. */
export function registerBalanceRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string } }>(
    '/groups/:id/balances',
    { schema: { response: { 200: { type: 'array', items: balanceSchema } } } },
    async request => {
      const accountId = await requireCaller(db, request);
      if (!(await findGroupOf(db, accountId, request.params.id))) {
        throw new Refusal(404, 'NotFound', 'There is no such group.');
      }
      return listBalances(db, request.params.id);
    },
  );
}

/**
 * The values of the memberships of the group, the members who have left included: each one's value, its raw balance less
 * its offset, as the balances count it, and whether the membership is active. A read changes nothing.
 */
export async function membershipValues(
  db: Queryable,
  groupId: string,
): Promise<Map<string, { active: boolean; value: number }>> {
  const values = new Map<string, { active: boolean; value: number }>();
  for (const row of await membershipsOf(db, groupId, "('paid', 'refunding')")) {
    values.set(row.member_id, { active: row.active === 1, value: row.raw - row.balance_offset });
  }
  return values;
}

/**
 * Sets the values of the memberships of the group, the ones of the members who left included, by setting their offsets:
 * `values` gives each member other than the owner. The owner's value is what makes the values add up to 0, as the
 * balances of the group always do; so the owner's balance is what the others' values leave. Called in the write
 * transaction that changes the memberships of the group, once the rows it holds are the ones it will keep.
 */
export async function setMembershipValues(
  db: Queryable,
  groupId: string,
  ownerId: string,
  values: ReadonlyMap<string, number>,
): Promise<void> {
  const rows = await membershipsOf(db, groupId, "('paid', 'refunding')");
  let others = 0;
  for (const row of rows) {
    if (row.member_id === ownerId) continue;
    const value = values.get(row.member_id);
    if (value === undefined) throw new Error(`No value is given for the member ${row.member_id} of ${groupId}.`);
    others += value;
  }
  for (const row of rows) {
    const value = row.member_id === ownerId ? -others : (values.get(row.member_id) as number);
    await db.run('UPDATE group_members SET balance_offset = ? WHERE group_id = ? AND account_id = ?', [
      row.raw - value,
      groupId,
      row.member_id,
    ]);
  }
}
