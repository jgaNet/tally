import type { FastifyInstance } from 'fastify';
import { writeAdminLog, hideUnlessAdministrator, refuseUnlessAdministrator } from './admin';
import { writeAudit } from './audit';
import type { Database } from './database';
import { refuseIfArchived } from './groups';
import { isMember } from './members';
import { Refusal } from './refusal';
import { moveSettlement } from './settlement-history';
import { findAnySettlement, findSettlementOf, listContestedSettlements, settlementSchema } from './settlements';
import { requireCaller } from './sessions';

/**
 * The payee of a settlement through the provider, whose status is `paid`, contests it: the money did not reach them. The
 * settlement is then `contested`, and held until an administrator decides it (see `decideContest`): the balances do not count
 * it meanwhile, though what its payer owes and its payee is owed counts it as paid. Only the payee may contest it, only once,
 * and only while its payer and its payee are members of the group. Contesting is audited as `settlement-contested`, by the
 * payee, with the amount.
 *
 * For an account that is not a member of the group the settlement does not exist; for a member who is not its payee the
 * contest is refused with `NotAllowed`. Anything else is refused and nothing changes. The checks and the contest are one
 * write transaction, so two contests asked at once are decided one after the other.
 */
export async function contestSettlement(db: Database, payeeId: string, settlementId: string): Promise<void> {
  await db.transaction(async tx => {
    const settlement = await findSettlementOf(tx, payeeId, settlementId);
    if (!settlement) throw new Refusal(404, 'NotFound', 'There is no such settlement.');
    await refuseIfArchived(tx, settlement.groupId);
    if (settlement.to !== payeeId)
      throw new Refusal(403, 'NotAllowed', 'Only the payee of the settlement may contest it.');
    if (settlement.method !== 'provider') {
      throw new Refusal(409, 'NotContestable', 'Only a settlement paid through the payment provider is contested.');
    }
    if (settlement.status !== 'paid') throw new Refusal(409, 'NotContestable', 'Only a paid settlement is contested.');
    if (settlement.history.some(entry => entry.status === 'contested')) {
      throw new Refusal(409, 'AlreadyContested', 'A settlement is contested once.');
    }
    if (
      !(await isMember(tx, settlement.groupId, settlement.from)) ||
      !(await isMember(tx, settlement.groupId, settlement.to))
    ) {
      throw new Refusal(
        409,
        'NotContestable',
        'The payer and the payee of the settlement must both be members of the group.',
      );
    }
    const at = new Date().toISOString();
    await moveSettlement(tx, settlementId, 'contested', at);
    await writeAudit(tx, settlement.groupId, {
      by: payeeId,
      action: 'settlement-contested',
      subjectId: settlementId,
      amount: settlement.amount,
      at,
    });
  });
}

/**
 * An administrator decides a contested settlement: `paid` when the money arrived, which makes it `paid` again, and counted as it
 * was before it was contested (audited as `settlement-paid`, by the administrator); otherwise `annulled`, which nothing counts any
 * more, and what was owed is owed again. Either way the decision is kept in the administrators' log. Only a contested settlement
 * is decided, once. Anyone else is refused with `NotAllowed`, and nothing changes; the decision is one write transaction.
 */
export async function decideContest(
  db: Database,
  adminId: string,
  adminEmails: ReadonlySet<string>,
  settlementId: string,
  paid: boolean,
): Promise<void> {
  await db.transaction(async tx => {
    await refuseUnlessAdministrator(tx, adminId, adminEmails);
    const settlement = await findAnySettlement(tx, settlementId);
    if (!settlement) throw new Refusal(404, 'NotFound', 'There is no such settlement.');
    if (settlement.status !== 'contested') {
      throw new Refusal(409, 'NotContested', 'Only a contested settlement is decided.');
    }
    const at = new Date().toISOString();
    if (paid) {
      await moveSettlement(tx, settlementId, 'paid', at);
      await writeAudit(tx, settlement.groupId, {
        by: adminId,
        action: 'settlement-paid',
        subjectId: settlementId,
        amount: settlement.amount,
        at,
      });
    } else {
      await moveSettlement(tx, settlementId, 'annulled', at);
    }
    await writeAdminLog(tx, {
      by: adminId,
      action: paid ? 'decided-paid' : 'decided-annulled',
      subjectId: settlementId,
      at,
    });
  });
}

/** The contested settlements are read by administrators only: for anyone else there is no such list. */
export function registerContestRoutes(app: FastifyInstance, db: Database, adminEmails: ReadonlySet<string>): void {
  app.post<{ Params: { id: string } }>('/settlements/:id/contest', async (request, reply) => {
    await contestSettlement(db, await requireCaller(db, request), request.params.id);
    return reply.code(204).send();
  });

  app.get(
    '/admin/contests',
    { schema: { response: { 200: { type: 'array', items: settlementSchema } } } },
    async request => {
      const accountId = await requireCaller(db, request);
      await hideUnlessAdministrator(db, accountId, adminEmails, 'contest');
      return listContestedSettlements(db);
    },
  );

  app.post<{ Params: { id: string }; Body: { paid: boolean } }>(
    '/admin/settlements/:id/decision',
    {
      schema: {
        body: { type: 'object', required: ['paid'], properties: { paid: { type: 'boolean' } } },
      },
    },
    async (request, reply) => {
      const accountId = await requireCaller(db, request);
      await decideContest(db, accountId, adminEmails, request.params.id, request.body.paid);
      return reply.code(204).send();
    },
  );
}
