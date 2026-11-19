import { CURRENCIES } from '@SharedKernel/Domain/Currency';
const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

const TransferSchema = {
  type: 'object',
  required: ['from', 'to', 'amount'],
  properties: { from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'integer', minimum: 1 } },
} as const;

/** A read: the transfers that would bring every balance of the group to 0, in the order made, to a member of the group only. */
export const GetSuggestedSettlementsResSchema = {
  200: { description: 'Success', type: 'array', items: TransferSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/**
 * What was paid in another currency, as a body gives it (request 39): its currency and its amount in that currency's hundredths. Whether the
 * currency is one of Tally's and the amount is in its range is the settlement's, behind the 202; a body without both is of the wrong shape.
 */
const OriginalBodySchema = {
  type: 'object',
  required: ['currency', 'amount'],
  properties: { currency: { type: 'string' }, amount: { type: 'integer' } },
} as const;

/** Exactly one of the two ways to give the money: neither, or both, is a body of the wrong shape (400, request 39). */
const ExactlyOneMoney = { oneOf: [{ required: ['amount'] }, { required: ['original'] }] } as const;

/** The shape of a body only: whether the amount is allowed (at least 1, never more than is owed) is the book's, behind the 202. */
export const RecordCashSettlementBodySchema = {
  type: 'object',
  required: ['from'],
  properties: { from: { type: 'string' }, amount: { type: 'integer' }, original: OriginalBodySchema },
  ...ExactlyOneMoney,
} as const;

/** Answered at once with an operation, or refused at the transport for a caller who is not signed in (request 1). */
export const LaterCommandResSchema = {
  202: { description: 'Accepted', type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

const SettlementSchema = {
  type: 'object',
  required: ['id', 'groupId', 'from', 'to', 'amount', 'method', 'status', 'at', 'history'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    amount: { type: 'integer', minimum: 1 },
    method: { enum: ['cash', 'provider', 'net'] },
    status: { enum: ['pending', 'paid', 'failed', 'refunding', 'refunded', 'contested', 'annulled'] },
    at: { type: 'string' },
    payUrl: { type: 'string', minLength: 1 },
    fee: {
      type: 'object',
      required: ['amount', 'borneBy'],
      properties: { amount: { type: 'integer', minimum: 0 }, borneBy: { enum: ['payer', 'payee', 'shared'] } },
    },
    original: {
      type: 'object',
      required: ['currency', 'amount', 'rate'],
      properties: {
        currency: { enum: [...CURRENCIES] },
        amount: { type: 'integer', minimum: 1 },
        rate: { type: 'string', pattern: '^\\d+(\\.\\d{1,6})?$' },
      },
    },
    history: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['status', 'at'],
        properties: {
          status: { enum: ['pending', 'paid', 'failed', 'refunding', 'refunded', 'contested', 'annulled'] },
          at: { type: 'string' },
        },
      },
    },
  },
} as const;

/** A read: a settlement, to a member of its group only; anyone else is told it does not exist. */
export const GetSettlementResSchema = {
  200: { description: 'Success', ...SettlementSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/** A read: the group's settlements, the most recently recorded first, to a member of the group only; anyone else is told it does not exist. */
export const GetGroupSettlementsResSchema = {
  200: { description: 'Success', type: 'array', items: SettlementSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/** The shape of a body only: whether the money arrived is the administrator's to say, behind the 202 (request 33). */
export const DecideContestBodySchema = {
  type: 'object',
  required: ['paid'],
  properties: { paid: { type: 'boolean' } },
} as const;

/** A read: the settlements contested now, the earliest contested first, to an administrator only; anyone else is told it does not exist. */
export const GetContestsResSchema = {
  200: { description: 'Success', type: 'array', items: SettlementSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/** The shape of a body only: a payment through the provider asks for a whole amount to a member; whether it is allowed is the book's. */
export const PayThroughProviderBodySchema = {
  type: 'object',
  required: ['to'],
  properties: { to: { type: 'string' }, amount: { type: 'integer' }, original: OriginalBodySchema },
  ...ExactlyOneMoney,
} as const;

/** The shape of a body only: who bears the fee is one of three, whether it is allowed is the book's, behind the 202 (request 38). */
export const SetFeePolicyBodySchema = {
  type: 'object',
  required: ['borneBy'],
  properties: { borneBy: { type: 'string' } },
} as const;

/** A read: who bears the provider's fee of the group's payments, to a member of the group only; anyone else is told it does not exist (request 38). */
export const GetFeePolicyResSchema = {
  200: {
    description: 'Success',
    type: 'object',
    required: ['borneBy'],
    properties: { borneBy: { enum: ['payer', 'payee', 'shared'] } },
  },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/** The provider's webhook, as it is sent: its shape only; whether the signature is the provider's is checked before the body is read. */
export const ReceivePaymentWebhookBodySchema = {
  type: 'object',
  required: ['id', 'paymentId', 'status', 'at'],
  properties: {
    id: { type: 'string' },
    paymentId: { type: 'string' },
    status: { type: 'string' },
    at: { type: 'string' },
  },
} as const;

/** The shape of a body only: a netting is with an account, in a currency; whether it is allowed is the netting's, behind the 202 (request 32). */
export const NetDebtsBodySchema = {
  type: 'object',
  required: ['with', 'currency'],
  properties: { with: { type: 'string' }, currency: { type: 'string' } },
} as const;

const NettingSchema = {
  type: 'object',
  required: ['id', 'by', 'with', 'currency', 'amount', 'settlements'],
  properties: {
    id: { type: 'string' },
    by: { type: 'string' },
    with: { type: 'string' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    amount: { type: 'integer', minimum: 1 },
    settlements: { type: 'array', minItems: 2, items: { type: 'string' } },
  },
} as const;

/** A read: a netting, to one of the two people only; anyone else is told it does not exist (request 32). */
export const GetNettingResSchema = {
  200: { description: 'Success', ...NettingSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
