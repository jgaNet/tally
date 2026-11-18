import { RefusedSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

const SPLIT_FIELDS = {
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

const RecurringSchema = {
  type: 'object',
  required: ['id', 'groupId', 'paidBy', 'description', 'amount', 'startsOn', 'next'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    paidBy: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    startsOn: { type: 'string' },
    next: { type: 'string' },
    ...SPLIT_FIELDS,
  },
} as const;

/** The shape of the body: a field missing or of the wrong type is a 400; whether a value is allowed is the domain's to decide. */
export const SetUpRecurringExpenseBodySchema = {
  type: 'object',
  required: ['description', 'amount', 'startsOn'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    startsOn: { type: 'string' },
    ...SPLIT_FIELDS,
  },
  allOf: [
    {
      oneOf: [{ required: ['splitBetween'] }, { required: ['splitExactly'] }, { required: ['splitByShares'] }],
    },
  ],
} as const;

export const SetUpRecurringExpenseResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  400: RefusedSchema,
  401: RefusedSchema,
} as const;

export const GetRecurringExpenseResSchema = {
  200: RecurringSchema,
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

export const GetGroupRecurringExpensesResSchema = {
  200: { type: 'array', items: RecurringSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

export const StopRecurringExpenseResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;
