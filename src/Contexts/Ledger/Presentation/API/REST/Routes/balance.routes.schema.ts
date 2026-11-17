import { RefusedSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

const BalanceSchema = {
  type: 'object',
  required: ['memberId', 'balance'],
  properties: {
    memberId: { type: 'string' },
    balance: { type: 'integer' },
  },
} as const;

/** A member's balances, in the order the members joined: a list of `{ memberId, balance }`. */
export const GetGroupBalancesResSchema = {
  200: { type: 'array', items: BalanceSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
