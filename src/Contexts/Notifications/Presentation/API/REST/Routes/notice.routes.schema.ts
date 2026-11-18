export const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

/** A notice: an expense's names its expense; a reminder's has none (request 18); a budget's names its category, month and budget (request 24). */
const NoticeSchema = {
  type: 'object',
  required: ['id', 'kind', 'groupId', 'amount', 'at'],
  properties: {
    id: { type: 'string' },
    kind: { enum: ['expense', 'reminder', 'budget'] },
    groupId: { type: 'string' },
    expenseId: { type: 'string' },
    amount: { type: 'integer' },
    at: { type: 'string' },
    category: { enum: ['groceries', 'rent', 'utilities', 'transport', 'food', 'travel', 'leisure', 'other'] },
    month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    budget: { type: 'integer', minimum: 1 },
  },
} as const;

/** A person's notices, the most recent first. */
export const GetMyNoticesResSchema = {
  200: { type: 'array', items: NoticeSchema },
  401: RefusedSchema,
} as const;
