import type { FastifyInstance } from 'fastify';
import { writeAudit } from './audit';
import { carriedBalanceOf } from './balances';
import type { Database } from './database';
import { findGroupOf, refuseIfArchived } from './groups';
import { Refusal } from './refusal';
import { hasWaitingSettlement } from './settlements';
import { requireCaller } from './sessions';

/**
 * The account leaves the group, whatever its balance is. The owner of the group cannot leave it. What the
 * account owes, or is owed, passes to the owner of the group, in the same write transaction that takes the
 * account out of the group (see `balances.ts`). A member who leaves is no longer among the members or the
 * balances of the group, nor is the group among their groups; the expenses they were in stay as they were. A
 * payment or refund through the provider still waiting for them keeps them in the group until it has ended. The
 * check and the leaving are one write transaction, so no expense or settlement can land between them. For an
 * account that is not a member, the group does not exist.
 */
export async function leaveGroup(db: Database, accountId: string, groupId: string): Promise<void> {
  await db.transaction(async tx => {
    const group = await findGroupOf(tx, accountId, groupId);
    if (!group) throw new Refusal(404, 'NotFound', 'There is no such group.');
    await refuseIfArchived(tx, groupId);
    if (group.ownerId === accountId) {
      throw new Refusal(403, 'OwnerCannotLeave', 'The owner cannot leave the group they created.');
    }
    // A payment or a refund through the provider still waiting for the member would move the balance the owner takes over.
    if (await hasWaitingSettlement(tx, groupId, accountId)) {
      throw new Refusal(
        409,
        'SettlementWaiting',
        'A payment or a refund through the provider is still waiting for this member.',
      );
    }
    const at = new Date().toISOString();
    // The balance the owner takes over is the member's as they leave, and it is audited when it is not 0.
    const balance = await carriedBalanceOf(tx, groupId, accountId);
    if (balance !== 0) {
      await writeAudit(tx, groupId, {
        by: accountId,
        action: 'balance-passed',
        subjectId: accountId,
        amount: balance,
        at,
      });
    }
    await tx.run('UPDATE group_members SET left_at = ? WHERE group_id = ? AND account_id = ?', [
      at,
      groupId,
      accountId,
    ]);
  });
}

export function registerLeaveRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Params: { id: string } }>('/groups/:id/leave', async (request, reply) => {
    const accountId = await requireCaller(db, request);
    await leaveGroup(db, accountId, request.params.id);
    return reply.code(204).send();
  });
}
