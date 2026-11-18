import type { FastifyInstance } from 'fastify';
import { hasProviderWaiting } from './archive';
import { membershipValues, setMembershipValues } from './balances';
import type { Database, Queryable } from './database';
import { findGroupOf, refuseIfArchived } from './groups';
import { addMember } from './members';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

/**
 * Merges the group `mergedId` into the group `keptId`, which is kept: the owner of both merges one into the other, in one
 * write transaction, so that nothing is recorded in the group merged meanwhile without being counted, or refused.
 *
 * Neither group may be archived, both must be in the same currency, and no payment or refund through the provider may
 * wait in the group merged. Every member of the group merged joins the group kept, unless they are one already, after its
 * members, in the order they joined the group merged; a former member of the group merged is a former member of the group
 * kept. Its expenses, settlements, recurring expenses and audit entries are the group kept's, each with its id and its
 * content; its notices stay as they were made. Its budgets, templates and invitations are dropped with it.
 *
 * Each member's balance in the group kept is then what it was there, plus what it was in the group merged. The balances
 * add up to 0 before and after, as the values of the memberships are set so: a member who left the group merged keeps
 * what they carried away in the owner's balance, and a member who joins the group kept starts with what the group merged
 * owed them.
 */
export async function mergeGroups(db: Database, accountId: string, keptId: string, mergedId: string): Promise<void> {
  if (keptId === mergedId) throw new Refusal(422, 'SameGroup', 'A group cannot be merged into itself.');
  await db.transaction(async tx => {
    const kept = await findGroupOf(tx, accountId, keptId);
    const merged = await findGroupOf(tx, accountId, mergedId);
    if (!kept || !merged) throw new Refusal(404, 'NotFound', 'There is no such group.');
    await refuseIfArchived(tx, kept.id);
    await refuseIfArchived(tx, merged.id);
    if (kept.ownerId !== accountId || merged.ownerId !== accountId) {
      throw new Refusal(403, 'NotAllowed', 'Only the owner of both groups may merge them.');
    }
    if (kept.currency !== merged.currency) {
      throw new Refusal(409, 'CurrencyMismatch', 'Only groups in the same currency may be merged.');
    }
    if (await hasProviderWaiting(tx, merged.id)) {
      throw new Refusal(
        409,
        'SettlementWaiting',
        'A payment or a refund through the provider is still waiting in the group.',
      );
    }
    await moveGroup(tx, kept.id, merged.id, kept.ownerId);
  });
}

/** Moves what the group merged holds into the group kept, and makes the group merged no longer exist. */
async function moveGroup(db: Queryable, keptId: string, mergedId: string, ownerId: string): Promise<void> {
  const keptBefore = await membershipValues(db, keptId);
  const mergedBefore = await membershipValues(db, mergedId);
  const mergedMembers = await db.all<{ account_id: string; joined_at: string; left_at: string | null }>(
    'SELECT account_id, joined_at, left_at FROM group_members WHERE group_id = ? ORDER BY joined_order NULLS LAST',
    [mergedId],
  );
  // The members of the group merged join the group kept in the order they joined it; those who left it are former members of it.
  for (const member of mergedMembers) {
    if (member.left_at === null) {
      if (!keptBefore.get(member.account_id)?.active) await addMember(db, keptId, member.account_id);
    } else if (!keptBefore.has(member.account_id)) {
      await db.run('INSERT INTO group_members (group_id, account_id, joined_at, left_at) VALUES (?, ?, ?, ?)', [
        keptId,
        member.account_id,
        member.joined_at,
        member.left_at,
      ]);
    }
  }

  // What the group merged holds is the group kept's: the rows keep their ids, their order and their content.
  for (const table of ['expenses', 'settlements', 'recurring', 'audit_entries']) {
    await db.run(`UPDATE ${table} SET group_id = ? WHERE group_id = ?`, [keptId, mergedId]);
  }
  // A member noted for a debt in both keeps the earlier note, as the debt has lasted since then.
  await db.run(
    `INSERT INTO debt_notes (group_id, account_id, noted_at, reminded_at)
     SELECT ?, account_id, noted_at, reminded_at FROM debt_notes WHERE group_id = ?
     ON CONFLICT (group_id, account_id) DO UPDATE SET
       noted_at = LEAST(debt_notes.noted_at, excluded.noted_at),
       reminded_at = GREATEST(debt_notes.reminded_at, excluded.reminded_at)`,
    [keptId, mergedId],
  );
  await db.run('DELETE FROM debt_notes WHERE group_id = ?', [mergedId]);

  // What is not moved goes with the group merged, which no longer has members, invitations, budgets or templates.
  await db.run('DELETE FROM invitations WHERE group_id = ?', [mergedId]);
  await db.run('DELETE FROM budget_passings WHERE group_id = ?', [mergedId]);
  await db.run('DELETE FROM budgets WHERE group_id = ?', [mergedId]);
  await db.run('DELETE FROM template_shares WHERE template_id IN (SELECT id FROM templates WHERE group_id = ?)', [
    mergedId,
  ]);
  await db.run('DELETE FROM templates WHERE group_id = ?', [mergedId]);
  await db.run('DELETE FROM group_members WHERE group_id = ?', [mergedId]);
  await db.run('UPDATE groups SET merged_into = ? WHERE id = ?', [keptId, mergedId]);

  // The values of the members of the group kept, once its members and rows are the ones it keeps. A member who is
  // active there keeps what they had in each group, and a former member keeps what they carried away from each.
  const keptAfter = await membershipValues(db, keptId);
  const values = new Map<string, number>();
  for (const [memberId, after] of keptAfter) {
    if (memberId === ownerId) continue;
    const before = keptBefore.get(memberId);
    const other = mergedBefore.get(memberId);
    values.set(
      memberId,
      after.active
        ? (before?.active ? before.value : 0) + (other?.active ? other.value : 0)
        : (before?.value ?? 0) + (other?.value ?? 0),
    );
  }
  await setMembershipValues(db, keptId, ownerId, values);
}

export function registerMergeRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Params: { id: string }; Body: { from: string } }>(
    '/groups/:id/merge',
    {
      schema: {
        body: { type: 'object', required: ['from'], properties: { from: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      await mergeGroups(db, await requireCaller(db, request), request.params.id, request.body.from);
      return reply.code(204).send();
    },
  );
}
