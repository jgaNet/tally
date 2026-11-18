import {
  CategoryProperty,
  SplitBody,
  SplitProperties,
  ExactlyOneSplit,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';
import { CATEGORIES, Category } from '@Contexts/Ledger/Domain/Expense/Category';

const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** A recurring expense as the API answers it to a member of its group (request 23): its split as it was given, one of the three keys. */
const RecurringSchema = {
  type: 'object',
  required: ['id', 'groupId', 'paidBy', 'description', 'amount', 'startsOn', 'next', 'category'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    paidBy: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    startsOn: { type: 'string', pattern: '^\\d{4}-\\d{2}-(0[1-9]|1\\d|2[0-8])$' },
    next: { type: 'string', pattern: '^\\d{4}-\\d{2}-(0[1-9]|1\\d|2[0-8])$' },
    category: { enum: [...CATEGORIES] },
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
  },
} as const;

/** Setting one up: the values are the domain's to refuse (a day, an amount, a split's members), so only their shapes are the transport's. */
export interface SetUpRecurringBody extends SplitBody {
  description: string;
  amount: number;
  startsOn: string;
  /** The category of the expenses it records, one of eight; `other` when left out (request 24). */
  category?: Category;
}

export const SetUpRecurringReqBodySchema = {
  type: 'object',
  required: ['description', 'amount', 'startsOn'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    startsOn: { type: 'string' },
    ...SplitProperties,
    ...CategoryProperty,
  },
  allOf: [ExactlyOneSplit],
} as const;

export const SetUpRecurringResSchema = {
  201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  202: { type: 'object', required: ['operationId'], properties: { operationId: { type: 'string' } } },
  400: RefusalSchema,
  401: RefusalSchema,
  404: RefusalSchema,
  409: RefusalSchema,
} as const;

export const GetRecurringResSchema = {
  200: RecurringSchema,
  401: RefusalSchema,
  404: RefusalSchema,
} as const;

export const GetGroupRecurringResSchema = {
  200: { type: 'array', items: RecurringSchema },
  401: RefusalSchema,
  404: RefusalSchema,
} as const;

export const StopRecurringResSchema = {
  201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  202: { type: 'object', required: ['operationId'], properties: { operationId: { type: 'string' } } },
  400: RefusalSchema,
  401: RefusalSchema,
  403: RefusalSchema,
  404: RefusalSchema,
  409: RefusalSchema,
} as const;
