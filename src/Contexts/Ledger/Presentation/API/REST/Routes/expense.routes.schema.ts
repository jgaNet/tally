const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

/** What was paid in another currency: its currency, its amount in that currency's hundredths, and the rate as the string given. */
const OriginalSchema = {
  type: 'object',
  required: ['currency', 'amount', 'rate'],
  properties: { currency: { type: 'string' }, amount: { type: 'integer' }, rate: { type: 'string' } },
} as const;

/** The category an expense reads with (request 24). */
export const CategorySchema = {
  enum: ['groceries', 'rent', 'utilities', 'transport', 'food', 'travel', 'leisure', 'other'],
} as const;

/** The category a body may give, by shape only: whether it is one of the eight is the expense's to decide, behind the 202. */
export const CategoryBodyProperty = { category: { type: 'string' } } as const;

const ExpenseSchema = {
  type: 'object',
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'splitKind', 'version', 'category', 'shares'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    paidBy: { type: 'string' },
    splitKind: { enum: ['equal', 'exact', 'shares'] },
    version: { type: 'integer', minimum: 1 },
    category: CategorySchema,
    shares: {
      type: 'array',
      items: {
        type: 'object',
        required: ['memberId', 'amount'],
        properties: { memberId: { type: 'string' }, amount: { type: 'integer' } },
      },
    },
    // What was paid in another currency (request 21): absent for an expense in the group's currency.
    original: OriginalSchema,
  },
} as const;

/**
 * What was paid, as a body gives it: its rate may be left out, and the expense then takes the rate offered for its day (request 22).
 * A rate given is a string, as request 21 says.
 */
const OriginalBodySchema = {
  type: 'object',
  required: ['currency', 'amount'],
  properties: { currency: { type: 'string' }, amount: { type: 'integer' }, rate: { type: 'string' } },
} as const;

/**
 * The money of an expense, as a body gives it: an amount in the group's currency, or what was paid in another currency (request
 * 21). Each is listed by shape only; the currency, the amount and the rate are the expense's to decide, behind the 202.
 */
const MoneyBodyProperties = { amount: { type: 'integer' }, original: OriginalBodySchema } as const;

/** Exactly one of the two ways to give the money: neither, or both, is a body of the wrong shape (400). */
const ExactlyOneMoney = {
  oneOf: [{ required: ['amount'] }, { required: ['original'] }],
} as const;

/**
 * The three ways to split, as a body gives them: exactly one of them (request 7). Each is listed by shape only; whether a
 * value is allowed (the amounts add up, a share is at least 1, a member listed once) is the expense's to decide, behind the 202.
 */
export const SplitBodyProperties = {
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
export const ExactlyOneSplit = {
  oneOf: [{ required: ['splitBetween'] }, { required: ['splitExactly'] }, { required: ['splitByShares'] }],
} as const;

/** The shape of a body only: whether a value is allowed is the expense's to decide, behind the 202 (API-BODY-SHAPE). */
export const RecordExpenseBodySchema = {
  type: 'object',
  required: ['description', 'date'],
  properties: {
    description: { type: 'string' },
    date: { type: 'string' },
    ...CategoryBodyProperty,
    ...MoneyBodyProperties,
    ...SplitBodyProperties,
  },
  allOf: [ExactlyOneMoney, ExactlyOneSplit],
} as const;

/** The body of an edit: the expense as it is given again, split one of the three ways, and the version its author read (request 6). */
export const EditExpenseBodySchema = {
  type: 'object',
  required: ['description', 'date', 'version'],
  properties: {
    description: { type: 'string' },
    date: { type: 'string' },
    version: { type: 'integer' },
    ...CategoryBodyProperty,
    ...MoneyBodyProperties,
    ...SplitBodyProperties,
  },
  allOf: [ExactlyOneMoney, ExactlyOneSplit],
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
