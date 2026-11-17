const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

const ExpenseSchema = {
  type: 'object',
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'splitKind', 'version', 'shares'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    paidBy: { type: 'string' },
    splitKind: { enum: ['equal', 'exact', 'shares'] },
    version: { type: 'integer', minimum: 1 },
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

/**
 * The three ways to split, as a body gives them: exactly one of them (request 7). Each is listed by shape only; whether a
 * value is allowed (the amounts add up, a share is at least 1, a member listed once) is the expense's to decide, behind the 202.
 */
const SplitBodyProperties = {
  splitBetween: { type: 'array', items: { type: 'string' } },
  splitExactly: {
    type: 'array',
    items: {
      type: 'object',
      required: ['memberId', 'amount'],
      properties: { memberId: { type: 'string' }, amount: { type: 'integer' } },
    },
  },
  splitByShares: {
    type: 'array',
    items: {
      type: 'object',
      required: ['memberId', 'shares'],
      properties: { memberId: { type: 'string' }, shares: { type: 'integer' } },
    },
  },
} as const;

/** Exactly one of the three split fields: none, or two or more, is a body of the wrong shape (400). */
const ExactlyOneSplit = {
  oneOf: [{ required: ['splitBetween'] }, { required: ['splitExactly'] }, { required: ['splitByShares'] }],
} as const;

/** The shape of a body only: whether a value is allowed is the expense's to decide, behind the 202 (API-BODY-SHAPE). */
export const RecordExpenseBodySchema = {
  type: 'object',
  required: ['description', 'amount', 'date'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    ...SplitBodyProperties,
  },
  ...ExactlyOneSplit,
} as const;

/** The body of an edit: the expense as it is given again, split one of the three ways, and the version its author read (request 6). */
export const EditExpenseBodySchema = {
  type: 'object',
  required: ['description', 'amount', 'date', 'version'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    version: { type: 'integer' },
    ...SplitBodyProperties,
  },
  ...ExactlyOneSplit,
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

/** A read (request 8): the group's expenses that have not been deleted, the latest date first, to a member of the group only. */
export const GetGroupExpensesResSchema = {
  200: { description: 'Success', type: 'array', items: ExpenseSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
