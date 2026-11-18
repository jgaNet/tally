const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/**
 * A member's statement, as the API answers it (request 8's `statement` resource, with request 29's `kind`): an expense's entry names
 * its expense, a settlement's entry names its settlement.
 */
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
        required: ['kind', 'date', 'description', 'paid', 'share', 'balance'],
        properties: {
          kind: { type: 'string', enum: ['expense', 'settlement'] },
          expenseId: { type: 'string' },
          settlementId: { type: 'string' },
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

/** The statement as CSV answers a body of text when it is read; a refusal is answered as the statement's are. */
export const GetMemberStatementCsvResSchema = {
  401: RefusalSchema,
  404: RefusalSchema,
} as const;
