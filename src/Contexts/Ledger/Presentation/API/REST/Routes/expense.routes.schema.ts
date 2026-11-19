import { CURRENCY_CODES } from '@SharedKernel/Domain';
/** What an expense is filed under (request 24): a string here; whether it is one of the list is the domain's to decide. */
const CategoryField = { type: 'string' } as const;

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

const ExactShareSchema = {
  type: 'object',
  required: ['memberId', 'amount'],
  properties: {
    memberId: { type: 'string' },
    amount: { type: 'integer' },
  },
} as const;

const SharesShareSchema = {
  type: 'object',
  required: ['memberId', 'shares'],
  properties: {
    memberId: { type: 'string' },
    shares: { type: 'integer' },
  },
} as const;

/** What an expense was paid in another currency: its currency, its amount in hundredths, and its rate as given (request 21). */
const OriginalSchema = {
  type: 'object',
  required: ['currency', 'amount', 'rate'],
  properties: {
    currency: { enum: [...CURRENCY_CODES] },
    amount: { type: 'integer', minimum: 1 },
    rate: { type: 'string', pattern: '^\\d+(\\.\\d{1,6})?$' },
  },
} as const;

const ExpenseSchema = {
  type: 'object',
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'splitKind', 'shares', 'category', 'version'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    original: OriginalSchema,
    date: { type: 'string' },
    paidBy: { type: 'string' },
    splitKind: { enum: ['equal', 'exact', 'shares'] },
    shares: { type: 'array', items: ShareSchema },
    category: { enum: ['groceries', 'rent', 'utilities', 'transport', 'food', 'travel', 'leisure', 'other'] },
    version: { type: 'integer', minimum: 1 },
  },
} as const;

/*
 * How an expense is split: exactly one of the three fields or `template`, each with its own shape. Two of them in one body,
 * or none, is the body's shape and a 400; whether the amounts add up or the shares are at least 1 is the domain's to decide.
 */
const SplitFields = {
  splitBetween: { type: 'array', items: { type: 'string' } },
  splitExactly: { type: 'array', items: ExactShareSchema },
  splitByShares: { type: 'array', items: SharesShareSchema },
  /** The id of a template of the group, split as it was saved, in place of one of the three (request 25). */
  template: { type: 'string' },
} as const;

const ExactlyOneOfTheSplits = [
  { required: ['splitBetween'] },
  { required: ['splitExactly'] },
  { required: ['splitByShares'] },
  { required: ['template'] },
] as const;

/*
 * The amount: `amount`, in the group's currency, or `original`, what was paid in another one, never both and never neither
 * (request 21). What `original` holds is the domain's to decide, as the amount is: the transport sees its shape only. Its
 * `rate` may be left out, and the rate offered for the day is taken (request 22).
 */
const AmountFields = {
  amount: { type: 'integer' },
  original: {
    type: 'object',
    required: ['currency', 'amount'],
    properties: {
      currency: { type: 'string' },
      amount: { type: 'integer' },
      rate: { type: 'string' },
    },
  },
} as const;

const ExactlyOneAmount = [{ required: ['amount'] }, { required: ['original'] }] as const;

/** The shape of each body: a field missing or of the wrong type is a 400; whether a value is allowed is the domain's. */
export const RecordExpenseBodySchema = {
  type: 'object',
  required: ['description', 'date'],
  properties: {
    description: { type: 'string' },
    date: { type: 'string' },
    category: CategoryField,
    ...AmountFields,
    ...SplitFields,
  },
  allOf: [{ oneOf: ExactlyOneOfTheSplits }, { oneOf: ExactlyOneAmount }],
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

/** A group's expenses, each as `GetExpenseResSchema` reads it: the latest date first, then the most recently recorded first. */
export const GetGroupExpensesResSchema = {
  200: { type: 'array', items: ExpenseSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/** The shape of an edit: the expense given again, whole, and the version it was read at. Whether the values are allowed is the domain's. */
export const EditExpenseBodySchema = {
  type: 'object',
  required: ['description', 'date', 'version'],
  properties: {
    description: { type: 'string' },
    date: { type: 'string' },
    category: CategoryField,
    ...AmountFields,
    ...SplitFields,
    version: { type: 'integer' },
  },
  allOf: [{ oneOf: ExactlyOneOfTheSplits }, { oneOf: ExactlyOneAmount }],
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
