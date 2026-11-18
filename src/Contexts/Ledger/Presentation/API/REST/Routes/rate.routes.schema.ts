import { CURRENCIES } from '@SharedKernel/Domain/Currency';

const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** The rate Tally offers from a currency to a group's, on a day, as the API answers it (request 22's `rate` resource). */
const RateSchema = {
  type: 'object',
  required: ['currency', 'date', 'rate'],
  properties: {
    currency: { enum: [...CURRENCIES] },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    rate: { type: 'string', pattern: '^\\d+(\\.\\d{1,6})?$' },
  },
} as const;

export const GetOfferedRateResSchema = {
  200: RateSchema,
  400: RefusalSchema,
  401: RefusalSchema,
  404: RefusalSchema,
} as const;
