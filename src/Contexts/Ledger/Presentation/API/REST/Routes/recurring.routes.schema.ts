import {
  ExactlyOneSplit,
  SplitBodyProperties,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

/**
 * A recurring expense as it reads (request 23): its payer, description, amount, `startsOn`, the next day it records, and the split
 * as it was given: exactly one of its three.
 */
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

/**
 * The body of a set-up: a description, an amount in the group's currency, the day it starts on, and one of the three splits. Each is
 * listed by shape only; whether a value is allowed (the start day, the amount, the split's members) is the recurring expense's to
 * decide, behind the 202 (API-BODY-SHAPE).
 */
export const SetUpRecurringBodySchema = {
  type: 'object',
  required: ['description', 'amount', 'startsOn'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    startsOn: { type: 'string' },
    ...SplitBodyProperties,
  },
  allOf: [ExactlyOneSplit],
} as const;

/** A command answered later: 202 with an operation, whose SUCCESS result is the recurring expense's id. */
export const LaterCommandResSchema = {
  202: { description: 'Accepted', type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

export const GetRecurringResSchema = {
  200: { description: 'Success', ...RecurringSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

export const GetGroupRecurringResSchema = {
  200: { description: 'Success', type: 'array', items: RecurringSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
