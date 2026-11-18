import { RefusedSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

/** A budget as a member reads it: its category, its amount, and what the current month spends in it (request 24). */
const BudgetSchema = {
  type: 'object',
  required: ['category', 'amount', 'spent'],
  properties: {
    category: { enum: ['groceries', 'rent', 'utilities', 'transport', 'food', 'travel', 'leisure', 'other'] },
    amount: { type: 'integer', minimum: 1 },
    spent: { type: 'integer', minimum: 0 },
  },
} as const;

/** The amount is an integer; whether it is from 1 to 100 000 000 is the domain's to decide. */
export const SetBudgetBodySchema = {
  type: 'object',
  required: ['amount'],
  properties: { amount: { type: 'integer' } },
} as const;

export const SetBudgetResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  400: RefusedSchema,
  401: RefusedSchema,
} as const;

export const RemoveBudgetResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

export const GetGroupBudgetsResSchema = {
  200: { type: 'array', items: BudgetSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
