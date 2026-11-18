import { CATEGORIES, Category } from '@Contexts/Ledger/Domain/Expense/Category';

const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** The body of a budget set: the amount, in the group's currency; its range is the domain's to refuse (request 24). */
export interface SetBudgetBody {
  amount: number;
}

export const SetBudgetReqBodySchema = {
  type: 'object',
  required: ['amount'],
  properties: { amount: { type: 'integer' } },
} as const;

/** The route's group and category: the category is one of eight, which the transport refuses otherwise. */
export const BudgetParamsSchema = {
  type: 'object',
  required: ['category'],
  properties: {
    id: { type: 'string' },
    category: { enum: [...CATEGORIES] },
  },
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

export const SetBudgetResSchema = CommandResSchema({
  201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
});

export const RemoveBudgetResSchema = CommandResSchema({
  201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
});

/** A budget as a member reads it: its category, its amount, and what the current month spends in the category. */
const BudgetSchema = {
  type: 'object',
  required: ['category', 'amount', 'spent'],
  properties: {
    category: { enum: [...CATEGORIES] },
    amount: { type: 'integer', minimum: 1 },
    spent: { type: 'integer', minimum: 0 },
  },
} as const;

export const GetGroupBudgetsResSchema = {
  200: { type: 'array', items: BudgetSchema },
  401: RefusalSchema,
  404: RefusalSchema,
} as const;

/** The category of a route, typed as the domain names it, once the transport has let it through. */
export const asCategory = (value: string): Category => value as Category;
