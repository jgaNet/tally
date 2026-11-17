const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

const ShareSchema = {
  type: 'object',
  required: ['memberId', 'amount'],
  properties: {
    memberId: { type: 'string' },
    amount: { type: 'integer' },
  },
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
    shares: { type: 'array', items: ShareSchema },
  },
} as const;

/** The shape of each body: a field missing or of the wrong type is a 400; whether a value is allowed is the domain's. */
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

export const RecordExpenseResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  400: RefusedSchema,
  401: RefusedSchema,
} as const;

export const GetExpenseResSchema = {
  200: ExpenseSchema,
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
