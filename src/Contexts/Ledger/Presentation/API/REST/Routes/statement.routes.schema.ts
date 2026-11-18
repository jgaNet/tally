const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

const StatementEntrySchema = {
  type: 'object',
  required: ['kind', 'date', 'description', 'paid', 'share', 'balance'],
  properties: {
    kind: { type: 'string', enum: ['expense', 'settlement'] },
    expenseId: { type: 'string' },
    settlementId: { type: 'string' },
    date: { type: 'string' },
    description: { type: 'string' },
    paid: { type: 'integer' },
    share: { type: 'integer' },
    balance: { type: 'integer' },
  },
} as const;

const StatementSchema = {
  type: 'object',
  required: ['memberId', 'balance', 'entries'],
  properties: {
    memberId: { type: 'string' },
    balance: { type: 'integer' },
    entries: { type: 'array', items: StatementEntrySchema },
  },
} as const;

/** A read (request 8, and its settlements of request 29): a member's statement, to a member of the group only; a member who has never been one does not exist. */
export const GetStatementResSchema = {
  200: { description: 'Success', ...StatementSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/**
 * The same statement as CSV (request 29). Its 200 is text, which the controller sends as it is: no schema serialises it, so only the
 * refusals, which are JSON, are described here.
 */
export const GetStatementCsvResSchema = {
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
