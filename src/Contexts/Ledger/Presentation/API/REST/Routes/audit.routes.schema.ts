const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

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
        'settlement-paid',
        'settlement-refunded',
        'settlement-contested',
        'balance-passed',
      ],
    },
    subjectId: { type: 'string' },
    amount: { type: 'integer' },
  },
} as const;

/** A read: the group's audit, every change of money, the oldest first, to a member of the group only. */
export const GetGroupAuditResSchema = {
  200: { description: 'Success', type: 'array', items: AuditEntrySchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
