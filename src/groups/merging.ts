import { type Database, inTransaction } from '../database';
import { Refusal } from '../refusal';
import { type Group, requireMembership, requireNotArchived } from './groups';

/**
 * Merges the group `mergedId` into the group `keptId`, by its owner, who must own both. Refused when they are one
 * group, when either is archived, when their currencies differ, while a payment through the provider in the group
 * merged is pending or being refunded, and while a payment is contested in either group. Anyone outside a group is refused with `404`, as for a group that does not
 * exist; a member who does not own it with `403`.
 *
 * Everything of the group merged moves to the group kept, keeping its id: its expenses, settlements, recurring
 * expenses, balance transfers, audit entries and debts noted. Its members join the group kept, after its members, in
 * the order they joined the group merged, each as a member; a member of both stays where they are, and a former
 * member of the group merged is a former member of the group kept. Its invitations, budgets and split templates do
 * not move: they go with it. The group merged is then gone, and its notices keep naming it, as they were made.
 *
 * It is one transaction under the write lock, so an expense or a settlement recorded in the group merged is either
 * in it before, and moved with the rest, or refused, because the group is gone by then.
 */
export async function mergeGroups(db: Database, keptId: string, mergedId: string, accountId: string): Promise<void> {
  await inTransaction(db, async () => {
    if (keptId === mergedId) {
      throw new Refusal(409, 'SameGroup', 'A group cannot be merged into itself.');
    }
    const kept = await ownedGroup(db, keptId, accountId);
    const merged = await ownedGroup(db, mergedId, accountId);
    await requireNotArchived(db, keptId);
    await requireNotArchived(db, mergedId);
    if (kept.currency !== merged.currency) {
      throw new Refusal(409, 'CurrencyMismatch', 'Only groups in the same currency can be merged.');
    }
    // A payment waiting at the provider, or a refund of one, would move a balance once the provider answers. A
    // contested payment is held until an administrator decides it, in either group: neither is merged meanwhile.
    const waiting = await db.row(
      `SELECT 1 FROM settlements WHERE group_id = ? AND status IN ('pending', 'refunding')`,
      [mergedId],
    );
    const contested = await db.row(`SELECT 1 FROM settlements WHERE group_id IN (?, ?) AND status = 'contested'`, [
      keptId,
      mergedId,
    ]);
    if (waiting) {
      throw new Refusal(
        409,
        'PaymentPending',
        'A payment or a refund through the provider is waiting in the group merged: it must end first.',
      );
    }
    if (contested) {
      throw new Refusal(
        409,
        'PaymentPending',
        'A payment through the provider is contested in one of the groups: it must be decided first.',
      );
    }
    await moveGroup(db, keptId, mergedId);
  });
}

/** The group, for its owner. Anyone outside it is refused with `404`; a member who is not its owner with `403`. */
async function ownedGroup(db: Database, groupId: string, accountId: string): Promise<Group> {
  const group = await requireMembership(db, groupId, accountId);
  if (group.ownerId !== accountId) {
    throw new Refusal(403, 'NotPermitted', 'Only the owner of the group may merge it.');
  }
  return group;
}

/** Moves what `mergedId` holds to `keptId`, and removes `mergedId`. Runs inside the transaction of the merge. */
async function moveGroup(db: Database, keptId: string, mergedId: string): Promise<void> {
  // The members of the group merged who are not in the group kept join it after its members, in the order they
  // joined the group merged. They all join at one instant, which is not before the last join of the group kept.
  const now = new Date().toISOString();
  const latest = await db.row<{ at: string | null }>(
    'SELECT MAX(joined_at) AS at FROM memberships WHERE group_id = ?',
    [keptId],
  );
  const joinedAt = latest?.at != null && latest.at > now ? latest.at : now;
  const joiners = await db.rows<{ account_id: string }>(
    `SELECT account_id FROM memberships
      WHERE group_id = ? AND account_id NOT IN (SELECT account_id FROM memberships WHERE group_id = ?)
      ORDER BY joined_at, seq`,
    [mergedId, keptId],
  );
  for (const { account_id: accountId } of joiners) {
    await db.execute('INSERT INTO memberships (group_id, account_id, joined_at) VALUES (?, ?, ?)', [
      keptId,
      accountId,
      joinedAt,
    ]);
  }

  // A former member of the group merged is a former member of the group kept, unless they are a member of it now.
  // One already a former member of the group kept keeps the leaving it has.
  await db.execute(
    `INSERT INTO former_members (group_id, account_id, left_at)
     SELECT ?, account_id, left_at FROM former_members
      WHERE group_id = ? AND account_id NOT IN (SELECT account_id FROM memberships WHERE group_id = ?)
     ON CONFLICT (group_id, account_id) DO NOTHING`,
    [keptId, mergedId, keptId],
  );

  // What the group merged holds, as it was: each row keeps its id and everything it says but its group.
  for (const table of ['expenses', 'settlements', 'recurring', 'balance_transfers', 'audit_entries']) {
    await db.execute(`UPDATE ${table} SET group_id = ? WHERE group_id = ?`, [keptId, mergedId]);
  }
  // A debt noted in the group kept stays noted there; one noted only in the group merged is noted there now.
  await db.execute(
    `INSERT INTO noted_debts (group_id, account_id, noted_at)
     SELECT ?, account_id, noted_at FROM noted_debts WHERE group_id = ?
     ON CONFLICT (group_id, account_id) DO NOTHING`,
    [keptId, mergedId],
  );

  // What does not move goes with the group merged: its memberships, invitations, budgets and split templates.
  for (const table of [
    'noted_debts',
    'former_members',
    'memberships',
    'invitations',
    'budget_passings',
    'budgets',
    'split_templates',
  ]) {
    await db.execute(`DELETE FROM ${table} WHERE group_id = ?`, [mergedId]);
  }
  await db.execute('DELETE FROM groups WHERE id = ?', [mergedId]);
}
