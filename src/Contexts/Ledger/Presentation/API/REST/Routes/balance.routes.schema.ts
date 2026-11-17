const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** A member's balance in a group, as the API answers it (request 5's `balance` resource). */
const BalanceSchema = {
  type: 'object',
  required: ['memberId', 'balance'],
  properties: { memberId: { type: 'string' }, balance: { type: 'integer' } },
} as const;

export const GetGroupBalancesResSchema = {
  200: { type: 'array', items: BalanceSchema },
  401: RefusalSchema,
  404: RefusalSchema,
} as const;
