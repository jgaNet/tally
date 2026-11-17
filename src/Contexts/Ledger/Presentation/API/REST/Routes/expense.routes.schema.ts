const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

const ExpenseSchema = {
  type: 'object',
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'shares'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    paidBy: { type: 'string' },
    shares: {
      type: 'array',
      items: {
        type: 'object',
        required: ['memberId', 'amount'],
        properties: { memberId: { type: 'string' }, amount: { type: 'integer' } },
      },
    },
  },
} as const;

/** The shape of a body only: whether a value is allowed is the expense's to decide, behind the 202 (API-BODY-SHAPE). */
export const RecordExpenseBodySchema = {
  type: 'object',
  required: ['description', 'amount', 'date', 'splitBetween'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    splitBetween: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** A command answered later: 202 with an operation, whose SUCCESS result is the expense's id. */
export const LaterCommandResSchema = {
  202: { description: 'Accepted', type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

export const GetExpenseResSchema = {
  200: { description: 'Success', ...ExpenseSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
