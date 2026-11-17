const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

const BalanceSchema = {
  type: 'object',
  required: ['memberId', 'balance'],
  properties: { memberId: { type: 'string' }, balance: { type: 'integer' } },
} as const;

/** A read: the balances of the group's members in the order they joined, to a member of the group only. */
export const GetBalancesResSchema = {
  200: { description: 'Success', type: 'array', items: BalanceSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
