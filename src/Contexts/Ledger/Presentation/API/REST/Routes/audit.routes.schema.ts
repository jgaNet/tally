import { RefusedSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

const AuditEntrySchema = {
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
        'settlement-contested',
        'settlement-paid',
        'settlement-refunded',
        'balance-passed',
      ],
    },
    subjectId: { type: 'string' },
    amount: { type: 'integer' },
  },
} as const;

/** A group's audit, every change of money in it, the oldest first. */
export const GetGroupAuditResSchema = {
  200: { type: 'array', items: AuditEntrySchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
