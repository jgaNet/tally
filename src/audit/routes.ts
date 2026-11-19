import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { requireMembership } from '../groups/groups';
import { auditOfGroup } from './audit';

const auditEntrySchema = {
  type: 'object',
  required: ['id', 'at', 'by', 'action', 'subjectId', 'amount'],
  properties: {
    id: { type: 'string' },
    at: { type: 'string' },
    by: { type: 'string' },
    action: {
      type: 'string',
      enum: [
        'expense-recorded',
        'expense-edited',
        'expense-deleted',
        'settlement-paid',
        'settlement-refunded',
        'settlement-contested',
        'balance-passed',
      ],
    },
    subjectId: { type: 'string' },
    amount: { type: 'integer' },
  },
};

export function registerAuditRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string } }>(
    '/groups/:id/audit',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'array', items: auditEntrySchema } },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      // Only the members of a group read its audit; anyone else is told it does not exist.
      await requireMembership(db, request.params.id, account.id);
      return await auditOfGroup(db, request.params.id);
    },
  );
}
