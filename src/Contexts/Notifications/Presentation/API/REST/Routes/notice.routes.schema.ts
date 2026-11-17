export const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

const NoticeSchema = {
  type: 'object',
  required: ['id', 'kind', 'groupId', 'expenseId', 'amount', 'at'],
  properties: {
    id: { type: 'string' },
    kind: { enum: ['expense'] },
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
