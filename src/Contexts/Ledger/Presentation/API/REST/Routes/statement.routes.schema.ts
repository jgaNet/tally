const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** A member's statement, as the API answers it (request 8's `statement` resource). */
const StatementSchema = {
  type: 'object',
  required: ['memberId', 'balance', 'entries'],
  properties: {
    memberId: { type: 'string' },
    balance: { type: 'integer' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['expenseId', 'date', 'description', 'paid', 'share', 'balance'],
        properties: {
          expenseId: { type: 'string' },
          date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          description: { type: 'string' },
          paid: { type: 'integer' },
          share: { type: 'integer' },
          balance: { type: 'integer' },
        },
      },
    },
  },
} as const;

export const GetMemberStatementResSchema = {
  200: StatementSchema,
  401: RefusalSchema,
  404: RefusalSchema,
} as const;
