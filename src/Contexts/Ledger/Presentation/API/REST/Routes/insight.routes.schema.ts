import { CATEGORIES } from '@Contexts/Ledger/Domain/Expense/Category';

const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** A line of a person's spending as the API answers it (request 37's `insight` resource). */
const InsightSchema = {
  type: 'object',
  required: ['month', 'currency', 'category', 'amount'],
  properties: {
    month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    category: { enum: [...CATEGORIES] },
    amount: { type: 'integer', minimum: 1 },
  },
} as const;

export const GetMyInsightsResSchema = {
  200: { type: 'array', items: InsightSchema },
  400: RefusalSchema,
  401: RefusalSchema,
  403: RefusalSchema,
} as const;
