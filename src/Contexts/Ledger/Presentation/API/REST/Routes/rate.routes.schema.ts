import { RefusedSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

const RateSchema = {
  type: 'object',
  required: ['currency', 'date', 'rate'],
  properties: {
    currency: { type: 'string' },
    date: { type: 'string' },
    rate: { type: 'string' },
  },
} as const;

/** The rate offered from a currency to the group's on a day (request 22): `{ currency, date, rate }`. */
export const GetOfferedRateResSchema = {
  200: RateSchema,
  400: RefusedSchema,
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
