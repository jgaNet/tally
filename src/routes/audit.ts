import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { auditOfGroup } from '../audit';
import { requireCaller } from '../http';

const AUDIT_ENTRY = {
  type: 'object',
  required: ['id', 'at', 'by', 'action', 'subjectId', 'amount'],
  properties: {
    id: { type: 'string' },
    at: { type: 'string' },
    by: { type: 'string' },
    action: {
      enum: [
        'expense-recorded',
        'expense-edited',
        'expense-deleted',
        'settlement-paid',
        'settlement-refunded',
        'balance-passed',
      ],
    },
    subjectId: { type: 'string' },
    amount: { type: 'integer' },
  },
};

export function registerAuditRoutes(server: FastifyInstance, db: DatabaseSync): void {
  // Only a member of the group reads its audit, the oldest first; to anyone else the group does not exist.
  server.get<{ Params: { id: string } }>(
    '/groups/:id/audit',
    { schema: { response: { 200: { type: 'array', items: AUDIT_ENTRY } } } },
    async request => {
      const caller = requireCaller(db, request);
      return auditOfGroup(db, caller.id, request.params.id);
    },
  );
}
