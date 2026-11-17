export const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

/** A notice: an expense's names its expense; a reminder's has none (request 18). */
const NoticeSchema = {
  type: 'object',
  required: ['id', 'kind', 'groupId', 'amount', 'at'],
  properties: {
    id: { type: 'string' },
    kind: { enum: ['expense', 'reminder'] },
    groupId: { type: 'string' },
    expenseId: { type: 'string' },
    amount: { type: 'integer' },
    at: { type: 'string' },
  },
} as const;

/** A person's notices, the most recent first. */
export const GetMyNoticesResSchema = {
  200: { type: 'array', items: NoticeSchema },
  401: RefusedSchema,
} as const;
