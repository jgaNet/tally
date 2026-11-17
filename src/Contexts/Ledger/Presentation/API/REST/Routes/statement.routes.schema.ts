import { RefusedSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

const StatementEntrySchema = {
  type: 'object',
  required: ['expenseId', 'date', 'description', 'paid', 'share', 'balance'],
  properties: {
    expenseId: { type: 'string' },
    date: { type: 'string' },
    description: { type: 'string' },
    paid: { type: 'integer' },
    share: { type: 'integer' },
    balance: { type: 'integer' },
  },
} as const;

const StatementSchema = {
  type: 'object',
  required: ['memberId', 'balance', 'entries'],
  properties: {
    memberId: { type: 'string' },
    balance: { type: 'integer' },
    entries: { type: 'array', items: StatementEntrySchema },
  },
} as const;

/** A member's statement in a group: its entries, the earliest first, and the balance the last one leaves. */
export const GetMemberStatementResSchema = {
  200: StatementSchema,
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
