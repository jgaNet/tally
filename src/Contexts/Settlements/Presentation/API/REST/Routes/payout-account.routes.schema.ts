const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

/** The shape of a body only: whether the provider knows the account is the provider's answer, behind the 202 (request 16). */
export const SetPayoutAccountBodySchema = {
  type: 'object',
  required: ['accountId'],
  properties: { accountId: { type: 'string' } },
} as const;

/** A read: a person's payout account, to that person only; `404` when they have set none. */
export const GetPayoutAccountResSchema = {
  200: {
    description: 'Success',
    type: 'object',
    required: ['accountId'],
    properties: { accountId: { type: 'string' } },
  },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
