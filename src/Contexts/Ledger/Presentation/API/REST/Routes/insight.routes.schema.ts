import { RefusedSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

/** A line of a person's spending insights: what they spent in a currency, in a category, in a month (request 37). */
const InsightSchema = {
  type: 'object',
  required: ['month', 'currency', 'category', 'amount'],
  properties: {
    month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    category: { enum: ['groceries', 'rent', 'utilities', 'transport', 'food', 'travel', 'leisure', 'other'] },
    amount: { type: 'integer', minimum: 1 },
  },
} as const;

export const GetMyInsightsResSchema = {
  200: { type: 'array', items: InsightSchema },
  401: RefusedSchema,
} as const;
