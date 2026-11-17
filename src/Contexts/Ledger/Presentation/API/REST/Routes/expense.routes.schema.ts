const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** An expense as the API answers it to a member of its group (request 4's `expense` resource). */
const ExpenseSchema = {
  type: 'object',
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'shares', 'version'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    paidBy: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    shares: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['memberId', 'amount'],
        properties: { memberId: { type: 'string' }, amount: { type: 'integer' } },
      },
    },
  },
} as const;

export const CreateExpenseReqBodySchema = {
  type: 'object',
  required: ['description', 'amount', 'date', 'splitBetween'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    splitBetween: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** Recording an expense answers its id at once, or the refusal that named the rule it broke. */
export const CreateExpenseResSchema = {
  201: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  202: {
    type: 'object',
    required: ['operationId'],
    properties: { operationId: { type: 'string' } },
  },
  400: RefusalSchema,
  401: RefusalSchema,
  404: RefusalSchema,
  409: RefusalSchema,
} as const;

export const GetExpenseResSchema = {
  200: ExpenseSchema,
  401: RefusalSchema,
  404: RefusalSchema,
} as const;

/** Editing an expense takes it whole, and the version its author read: the answer is its id, or the refusal that named the rule. */
export const EditExpenseReqBodySchema = {
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

const CommandResSchema = (success: object) => ({
  ...success,
  202: {
    type: 'object',
    required: ['operationId'],
    properties: { operationId: { type: 'string' } },
  },
  400: RefusalSchema,
  401: RefusalSchema,
  403: RefusalSchema,
  404: RefusalSchema,
  409: RefusalSchema,
});

export const EditExpenseResSchema = CommandResSchema({
  201: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
});

export const DeleteExpenseResSchema = CommandResSchema({
  201: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
});
