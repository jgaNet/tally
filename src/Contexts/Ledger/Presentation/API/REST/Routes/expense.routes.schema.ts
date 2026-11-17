export const RefusedSchema = {
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
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'shares', 'version'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    paidBy: { type: 'string' },
    shares: { type: 'array', items: ShareSchema },
    version: { type: 'integer', minimum: 1 },
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

/** The shape of an edit: the expense given again, whole, and the version it was read at. Whether the values are allowed is the domain's. */
export const EditExpenseBodySchema = {
  type: 'object',
  required: ['description', 'amount', 'date', 'splitBetween', 'version'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    splitBetween: { type: 'array', items: { type: 'string' } },
    version: { type: 'integer' },
  },
} as const;

export const EditExpenseResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  400: RefusedSchema,
  401: RefusedSchema,
} as const;

export const DeleteExpenseResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;
