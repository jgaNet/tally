const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** An expense as the API answers it to a member of its group (request 4's `expense` resource). */
const ExpenseSchema = {
  type: 'object',
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'shares', 'splitKind', 'version'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    paidBy: { type: 'string' },
    splitKind: { enum: ['equal', 'exact', 'shares'] },
    version: { type: 'integer', minimum: 1 },
    // Only an expense in another currency has it (request 21): what was paid, and the rate it was paid at.
    original: {
      type: 'object',
      required: ['currency', 'amount', 'rate'],
      properties: {
        currency: { type: 'string' },
        amount: { type: 'integer' },
        rate: { type: 'string' },
      },
    },
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

/**
 * The split of an expense, as the body gives it: exactly one of three (request 7). Which one is the transport's to
 * refuse (a body with none, or with more than one, answers 400); the values of the split are the domain's.
 */
export interface SplitBody {
  /** An equal split: the members' account ids, in the order given. */
  splitBetween?: string[];
  /** A split by exact amounts: each member with the exact amount of their share. */
  splitExactly?: { memberId: string; amount: number }[];
  /** A split by shares: each member with a whole number of shares. */
  splitByShares?: { memberId: string; shares: number }[];
}

/** What was paid in another currency, as the body gives it: the values are the domain's to refuse, not the transport's. */
export interface OriginalBody {
  currency: string;
  amount: number;
  /** Left out, the rate offered for the currency and the day is taken (request 22). */
  rate?: string;
}

/** The amount, as the body gives it: in the group's currency, or what was paid in another currency (exactly one). */
export interface AmountBody {
  amount?: number;
  original?: OriginalBody;
}

export interface CreateExpenseBody extends SplitBody, AmountBody {
  description: string;
  date: string;
}

export interface EditExpenseBody extends CreateExpenseBody {
  version: number;
}

const SplitProperties = {
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

/** Exactly one of the three splits: each alone is required, and two of them together match none of the branches. */
const ExactlyOneSplit = {
  oneOf: [{ required: ['splitBetween'] }, { required: ['splitExactly'] }, { required: ['splitByShares'] }],
} as const;

/** The amount, in the group's currency or in another one: exactly one of the two, as the split is (request 21). */
const AmountProperties = {
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
const ExactlyOneAmount = {
  oneOf: [{ required: ['amount'] }, { required: ['original'] }],
} as const;

export const CreateExpenseReqBodySchema = {
  type: 'object',
  required: ['description', 'date'],
  properties: {
    description: { type: 'string' },
    date: { type: 'string' },
    ...AmountProperties,
    ...SplitProperties,
  },
  allOf: [ExactlyOneSplit, ExactlyOneAmount],
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

/** The group's expenses, the latest date first, each as it reads on its own (request 8). */
export const GetGroupExpensesResSchema = {
  200: { type: 'array', items: ExpenseSchema },
  401: RefusalSchema,
  404: RefusalSchema,
} as const;

/** Editing an expense takes it whole, and the version its author read: the answer is its id, or the refusal that named the rule. */
export const EditExpenseReqBodySchema = {
  type: 'object',
  required: ['description', 'date', 'version'],
  properties: {
    description: { type: 'string' },
    date: { type: 'string' },
    version: { type: 'integer' },
    ...AmountProperties,
    ...SplitProperties,
  },
  allOf: [ExactlyOneSplit, ExactlyOneAmount],
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
