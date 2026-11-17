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

/** The shape of a body only: whether the amount is allowed (at least 1, never more than is owed) is the book's, behind the 202. */
export const RecordCashSettlementBodySchema = {
  type: 'object',
  required: ['from', 'amount'],
  properties: { from: { type: 'string' }, amount: { type: 'integer' } },
} as const;

/** Answered at once with an operation, or refused at the transport for a caller who is not signed in (request 1). */
export const LaterCommandResSchema = {
  202: { description: 'Accepted', type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

const SettlementSchema = {
  type: 'object',
  required: ['id', 'groupId', 'from', 'to', 'amount', 'method', 'status', 'at'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    amount: { type: 'integer', minimum: 1 },
    method: { enum: ['cash', 'provider'] },
    status: { enum: ['pending', 'paid', 'failed'] },
    at: { type: 'string' },
    payUrl: { type: 'string', minLength: 1 },
  },
} as const;

/** A read: a settlement, to a member of its group only; anyone else is told it does not exist. */
export const GetSettlementResSchema = {
  200: { description: 'Success', ...SettlementSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/** The shape of a body only: a payment through the provider asks for a whole amount to a member; whether it is allowed is the book's. */
export const PayThroughProviderBodySchema = {
  type: 'object',
  required: ['to', 'amount'],
  properties: { to: { type: 'string' }, amount: { type: 'integer' } },
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
