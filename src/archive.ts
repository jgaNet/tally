import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { listBalances } from './balances';
import { inTransaction } from './database';
import { findGroupOf, refuseIfArchived } from './groups';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

/** Whether a payment or a refund through the provider waits in the group, whoever it is for. */
function hasProviderWaiting(db: DatabaseSync, groupId: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM settlements WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'refunding')",
      )
      .get(groupId) !== undefined
  );
}

/**
 * Archives the group, which is then read only, for good. Only its owner may, and only once every member's balance is 0
 * and no payment or refund through the provider is `pending` or `refunding`; otherwise it is refused and nothing changes.
 * Archiving it again is refused with `GroupArchived`, as every other change to an archived group is. For an account that
 * is not a member, the group does not exist. The checks and the archiving are one write transaction, so a settlement or
 * an expense recorded meanwhile is seen, or waits until the group is archived and is refused.
 */
export function archiveGroup(db: DatabaseSync, accountId: string, groupId: string): void {
  inTransaction(db, () => {
    const group = findGroupOf(db, accountId, groupId);
    if (!group) throw new Refusal(404, 'NotFound', 'There is no such group.');
    refuseIfArchived(db, groupId);
    if (group.ownerId !== accountId) {
      throw new Refusal(403, 'NotAllowed', 'Only the owner of the group may archive it.');
    }
    if (listBalances(db, groupId).some(row => row.balance !== 0)) {
      throw new Refusal(409, 'BalancesNotZero', 'Every balance of the group must be 0 to archive it.');
    }
    if (hasProviderWaiting(db, groupId)) {
      throw new Refusal(
        409,
        'SettlementWaiting',
        'A payment or a refund through the provider is still waiting in the group.',
      );
    }
    db.prepare('UPDATE groups SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), groupId);
  });
}

export function registerArchiveRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.post<{ Params: { id: string } }>('/groups/:id/archive', (request, reply) => {
    archiveGroup(db, requireCaller(db, request), request.params.id);
    return reply.code(204).send();
  });
}
