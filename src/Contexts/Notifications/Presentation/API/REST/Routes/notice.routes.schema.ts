const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** A notice, as its recipient reads it (request 17's `notice` resource, restated by request 18: a reminder has no expense). */
const NoticeSchema = {
  type: 'object',
  required: ['id', 'kind', 'groupId', 'amount', 'at'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['expense', 'reminder'] },
    groupId: { type: 'string' },
    expenseId: { type: 'string' },
    amount: { type: 'integer' },
    at: { type: 'string' },
  },
} as const;

export const GetMyNoticesResSchema = {
  200: { type: 'array', items: NoticeSchema },
  401: RefusalSchema,
} as const;
