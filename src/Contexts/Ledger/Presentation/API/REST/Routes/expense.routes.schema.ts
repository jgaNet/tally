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

export interface CreateExpenseBody extends SplitBody {
  description: string;
  amount: number;
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

export const CreateExpenseReqBodySchema = {
  type: 'object',
  required: ['description', 'amount', 'date'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    ...SplitProperties,
  },
  ...ExactlyOneSplit,
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
  required: ['description', 'amount', 'date', 'version'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    version: { type: 'integer' },
    ...SplitProperties,
  },
  ...ExactlyOneSplit,
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
