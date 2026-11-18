const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/**
 * A notice, as its recipient reads it (request 17's `notice` resource, restated by request 18: a reminder has no expense; request 24:
 * a budget's notice names its category, month and budget, and its amount is what the month spends).
 */
const NoticeSchema = {
  type: 'object',
  required: ['id', 'kind', 'groupId', 'amount', 'at'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['expense', 'reminder', 'budget'] },
    groupId: { type: 'string' },
    expenseId: { type: 'string' },
    amount: { type: 'integer' },
    at: { type: 'string' },
    category: { type: 'string' },
    month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    budget: { type: 'integer', minimum: 1 },
  },
} as const;

export const GetMyNoticesResSchema = {
  200: { type: 'array', items: NoticeSchema },
  401: RefusalSchema,
} as const;
