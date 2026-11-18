import { CategorySchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

/** One line of a person's insights: what they spent in a month, a currency and a category, as the sum of their shares (request 37). */
const InsightSchema = {
  type: 'object',
  required: ['month', 'currency', 'category', 'amount'],
  properties: {
    month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    category: CategorySchema,
    amount: { type: 'integer', minimum: 1 },
  },
} as const;

/** A read: the signed-in person's own insights, the earliest month first, to that person only. */
export const GetInsightsResSchema = {
  200: { description: 'Success', type: 'array', items: InsightSchema },
  401: RefusedSchema,
} as const;
