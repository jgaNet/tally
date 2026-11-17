import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { listBalances } from './balances';
import { inTransaction } from './database';
import { findGroupOf } from './groups';
import { Refusal } from './refusal';
import { hasWaitingSettlement } from './settlements';
import { requireCaller } from './sessions';

/**
 * The account leaves the group, once its balance in the group is 0. The owner of the group cannot leave
 * it. A member who leaves is no longer among the members or the balances of the group, nor is the group
 * among their groups; the expenses they were in stay as they were. The check and the leaving are one
 * write transaction, so no expense can land between them. For an account that is not a member, the
 * group does not exist.
 */
export function leaveGroup(db: DatabaseSync, accountId: string, groupId: string): void {
  inTransaction(db, () => {
    const group = findGroupOf(db, accountId, groupId);
    if (!group) throw new Refusal(404, 'NotFound', 'There is no such group.');
    if (group.ownerId === accountId) {
      throw new Refusal(403, 'OwnerCannotLeave', 'The owner cannot leave the group they created.');
    }
    const balance = listBalances(db, groupId).find(row => row.memberId === accountId)?.balance ?? 0;
    if (balance !== 0) throw new Refusal(409, 'BalanceNotZero', 'The balance must be 0 to leave the group.');
    // A payment or a refund through the provider still waiting for the member would move their balance after they left.
    if (hasWaitingSettlement(db, groupId, accountId)) {
      throw new Refusal(
        409,
        'SettlementWaiting',
        'A payment or a refund through the provider is still waiting for this member.',
      );
    }
    db.prepare('UPDATE group_members SET left_at = ? WHERE group_id = ? AND account_id = ?').run(
      new Date().toISOString(),
      groupId,
      accountId,
    );
  });
}

export function registerLeaveRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.post<{ Params: { id: string } }>('/groups/:id/leave', (request, reply) => {
    const accountId = requireCaller(db, request);
    leaveGroup(db, accountId, request.params.id);
    return reply.code(204).send();
  });
}
