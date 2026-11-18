import type { Database, Querier } from './database';
import { rawBalanceOf } from './balances';
import { assertNotArchived, findGroupOfMember } from './groups';
import { Refusal } from './refusal';
import { inTransaction } from './transactions';

/** A membership of the group merged: who, when they joined, when they left if they did, and the part of their balance passed on. */
interface MergedMembershipRow {
  account_id: string;
  joined_at: string;
  left_at: string | null;
  balance_base: number;
}

/** A membership of the group kept, as it is before the merge. */
interface KeptMembershipRow {
  left_at: string | null;
  balance_base: number;
}

/**
 * Merges the group `mergedId` into the group `keptId`, which the caller owns both of, in the same currency. The merge is one
 * write transaction, so an expense or settlement recorded at the same moment is either counted in the group kept, once, or
 * refused because the group merged no longer exists.
 *
 * Refused, in this order: `404` when the caller is not a current member of either group (as if it did not exist); `422` as
 * `GroupsAreTheSame` when both are one group; `409` as `GroupIsArchived` when either is archived (see {@link assertNotArchived});
 * `403` as `NotOwner` when the caller does not own both; `422` as `CurrenciesDiffer` when their currencies differ; `409` as
 * `SettlementIsInProgress` while a settlement through the provider in the group merged is `pending` or `refunding`.
 *
 * Once it is done: the members of the group merged join the group kept, after its members, in the order they had joined the
 * group merged (a member of both stays where they are; a former member of the group merged is a former member of the group
 * kept). The expenses, settlements, recurring expenses and audit entries of the group merged are the group kept's, each with its
 * id and everything it says but its group. The budgets, templates and invitations of the group merged are dropped, and its
 * notices stay as they were made. The group merged no longer exists.
 *
 * The balances. The balance of a membership is its raw balance (what it paid less its shares, plus its settlements) less its
 * `balance_base`, the part already passed on (see `balances.ts`). The base of each membership is updated so that every
 * member's balance in the group kept is what it was there plus what it was in the group merged, and the owner takes on what
 * the former members of the group merged had passed on, so the balances still add up to 0.
 */
export async function mergeGroups(
  db: Database,
  input: { groupId: string; from: string; accountId: string },
): Promise<void> {
  const { groupId: keptId, from: mergedId, accountId } = input;
  await inTransaction(db, async tx => {
    const kept = await findGroupOfMember(tx, accountId, keptId);
    if (!kept) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    const merged = await findGroupOfMember(tx, accountId, mergedId);
    if (!merged) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    if (keptId === mergedId) throw new Refusal(422, 'GroupsAreTheSame', 'A group cannot be merged into itself.');
    assertNotArchived(kept);
    assertNotArchived(merged);
    if (kept.ownerId !== accountId || merged.ownerId !== accountId) {
      throw new Refusal(403, 'NotOwner', 'Only the owner of both groups may merge them.');
    }
    if (kept.currency !== merged.currency) {
      throw new Refusal(422, 'CurrenciesDiffer', 'Only groups in the same currency may be merged.');
    }
    const waiting = await tx
      .prepare(
        `SELECT 1 FROM settlements
         WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'refunding')`,
      )
      .get(mergedId);
    if (waiting !== undefined) {
      throw new Refusal(
        409,
        'SettlementIsInProgress',
        'A settlement through the provider in the group merged has not ended yet.',
      );
    }

    const at = new Date().toISOString();
    await moveMemberships(tx, { keptId, mergedId, ownerId: kept.ownerId, at });

    await tx.prepare('UPDATE expenses SET group_id = ? WHERE group_id = ?').run(keptId, mergedId);
    await tx.prepare('UPDATE settlements SET group_id = ? WHERE group_id = ?').run(keptId, mergedId);
    await tx.prepare('UPDATE recurring SET group_id = ? WHERE group_id = ?').run(keptId, mergedId);
    await tx.prepare('UPDATE audit_entries SET group_id = ? WHERE group_id = ?').run(keptId, mergedId);

    // What does not move: the group merged's budgets, templates and invitations go with it, and so does its lasting debts,
    // which the reminders look at again in the group kept.
    await tx.prepare('DELETE FROM budget_months_passed WHERE group_id = ?').run(mergedId);
    await tx.prepare('DELETE FROM budgets WHERE group_id = ?').run(mergedId);
    await tx
      .prepare('DELETE FROM template_parts WHERE template_id IN (SELECT id FROM templates WHERE group_id = ?)')
      .run(mergedId);
    await tx.prepare('DELETE FROM templates WHERE group_id = ?').run(mergedId);
    await tx.prepare('DELETE FROM invitations WHERE group_id = ?').run(mergedId);
    await tx.prepare('DELETE FROM lasting_debts WHERE group_id = ?').run(mergedId);
    await tx.prepare('DELETE FROM group_members WHERE group_id = ?').run(mergedId);
    await tx.prepare('DELETE FROM groups WHERE id = ?').run(mergedId);
  });
}

/**
 * Moves the memberships of the group merged into the group kept, and sets each base so the balances come out as
 * {@link mergeGroups} says. Every raw balance is read before anything moves; the expenses are moved afterwards, by the caller.
 *
 * For each account of the group merged, by the order it joined it, with `m` its membership there and `k` its one in the group
 * kept, if any; `raw` is what the account's expenses and settlements count in a group, `c = raw - base` its balance:
 * - no `k`: `m` moves, with its base, and joins at `at` when it is a current member (a former one keeps its record);
 * - `k` a current member, `m` a current one: `k`'s base grows by `m`'s, so the two balances add;
 * - `k` a current member, `m` a former one: `k` keeps its balance (its base grows by `raw_m`, so its raw does not show it),
 *   and what `m` had passed on to the owner goes to the owner (the owner's base shrinks by `c_m`);
 * - `k` a former member, `m` a former one: `k`'s base grows by `m`'s, and what it passed on grows by `c_m`, which the owner holds;
 * - `k` a former member, `m` a current one: `k` is joined afresh, as an invitation joins an account that left (see
 *   `acceptInvitation`): what `k` passed on stays with the owner (the owner's base shrinks by `c_k`), and the member joins at
 *   `at` with a base of `raw_k + base_m`, so its balance is `c_m`.
 */
async function moveMemberships(
  tx: Querier,
  input: { keptId: string; mergedId: string; ownerId: string; at: string },
): Promise<void> {
  const { keptId, mergedId, ownerId, at } = input;
  const mergedRows = await tx
    .prepare(
      `SELECT account_id, joined_at, left_at, balance_base FROM group_members
       WHERE group_id = ? ORDER BY joined_at ASC, seq ASC`,
    )
    .all<MergedMembershipRow>(mergedId);
  const keptRows = new Map(
    (
      await tx
        .prepare('SELECT account_id, left_at, balance_base FROM group_members WHERE group_id = ?')
        .all<KeptMembershipRow & { account_id: string }>(keptId)
    ).map(row => [row.account_id, row]),
  );
  let ownerBaseChange = 0;
  for (const row of mergedRows) {
    const accountId = row.account_id;
    const isCurrent = row.left_at === null;
    const existing = keptRows.get(accountId);
    if (existing === undefined) {
      await tx
        .prepare(
          'INSERT INTO group_members (group_id, account_id, joined_at, left_at, balance_base) VALUES (?, ?, ?, ?, ?)',
        )
        .run(keptId, accountId, isCurrent ? at : row.joined_at, row.left_at, row.balance_base);
      continue;
    }
    const rawMerged = await rawBalanceOf(tx, mergedId, accountId);
    const addToBase = tx.prepare(
      'UPDATE group_members SET balance_base = balance_base + ? WHERE group_id = ? AND account_id = ?',
    );
    if (existing.left_at === null) {
      if (isCurrent) {
        await addToBase.run(row.balance_base, keptId, accountId);
      } else {
        await addToBase.run(rawMerged, keptId, accountId);
        ownerBaseChange -= rawMerged - row.balance_base;
      }
    } else if (!isCurrent) {
      await addToBase.run(row.balance_base, keptId, accountId);
    } else {
      const rawKept = await rawBalanceOf(tx, keptId, accountId);
      ownerBaseChange -= rawKept - existing.balance_base;
      await tx.prepare('DELETE FROM group_members WHERE group_id = ? AND account_id = ?').run(keptId, accountId);
      await tx
        .prepare('INSERT INTO group_members (group_id, account_id, joined_at, balance_base) VALUES (?, ?, ?, ?)')
        .run(keptId, accountId, at, rawKept + row.balance_base);
    }
  }
  if (ownerBaseChange !== 0) {
    await tx
      .prepare('UPDATE group_members SET balance_base = balance_base + ? WHERE group_id = ? AND account_id = ?')
      .run(ownerBaseChange, keptId, ownerId);
  }
}
