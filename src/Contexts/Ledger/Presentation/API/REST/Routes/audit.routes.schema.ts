const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** One entry of a group's audit, as the API answers it (request 28's `auditEntry` resource). */
const AuditEntrySchema = {
  type: 'object',
  required: ['id', 'at', 'by', 'action', 'subjectId', 'amount'],
  properties: {
    id: { type: 'string' },
    at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]00:?00)$' },
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
} as const;

export const GetGroupAuditResSchema = {
  200: { type: 'array', items: AuditEntrySchema },
  401: RefusalSchema,
  404: RefusalSchema,
} as const;
