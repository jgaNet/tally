const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

/** The rate a rates service offers from a currency to the group's on a day (request 22). */
const RateSchema = {
  type: 'object',
  required: ['currency', 'date', 'rate'],
  properties: { currency: { type: 'string' }, date: { type: 'string' }, rate: { type: 'string' } },
} as const;

/** A read: the rate offered from a currency to the group's on a day (today when no day is given), to a member of the group only. */
export const GetOfferedRateResSchema = {
  200: { description: 'Success', ...RateSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
