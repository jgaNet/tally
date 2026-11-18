import { RefusedSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

/**
 * An entry of a statement: an expense's (its `expenseId`), or a settlement's (its `settlementId`, request 29). Its kind is
 * named, and the id the kind names is the one it carries.
 */
const StatementEntrySchema = {
  type: 'object',
  required: ['kind', 'date', 'description', 'paid', 'share', 'balance'],
  properties: {
    kind: { type: 'string', enum: ['expense', 'settlement'] },
    expenseId: { type: 'string' },
    settlementId: { type: 'string' },
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

/** A member's statement as CSV (request 29): a text body, so no schema for the 200; a refusal is the same JSON as the statement's. */
export const GetMemberStatementCsvResSchema = {
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
