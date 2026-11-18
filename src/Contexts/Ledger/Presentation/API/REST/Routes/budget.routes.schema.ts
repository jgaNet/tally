import { CategorySchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

/** The body of a budget: its amount, by shape only; whether it is from 1 to 100 000 000 is the budget's to decide, behind the 202. */
export const SetBudgetBodySchema = {
  type: 'object',
  required: ['amount'],
  properties: { amount: { type: 'integer' } },
} as const;

/** A command answered later: 202 with an operation (request 1). */
export const LaterCommandResSchema = {
  202: { description: 'Accepted', type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

/** A read: the group's budgets, in the order of the categories, to a member of the group only. */
export const GetBudgetsResSchema = {
  200: {
    description: 'Success',
    type: 'array',
    items: {
      type: 'object',
      required: ['category', 'amount', 'spent'],
      properties: { category: CategorySchema, amount: { type: 'integer' }, spent: { type: 'integer' } },
    },
  },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
