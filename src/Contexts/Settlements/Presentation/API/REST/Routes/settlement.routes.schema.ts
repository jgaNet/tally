const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

const TransferSchema = {
  type: 'object',
  required: ['from', 'to', 'amount'],
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    amount: { type: 'integer', minimum: 1 },
  },
} as const;

/** The transfers that would bring every balance of the group to 0, in the order they are made. */
export const GetSuggestedSettlementsResSchema = {
  200: { type: 'array', items: TransferSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/** The shape of a cash settlement: the payer's account id and the amount. Whether the amount is allowed is the domain's. */
export const RecordCashSettlementBodySchema = {
  type: 'object',
  required: ['from', 'amount'],
  properties: {
    from: { type: 'string' },
    amount: { type: 'integer' },
  },
} as const;

export const RecordCashSettlementResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  400: RefusedSchema,
  401: RefusedSchema,
} as const;

/** The body of a payment through the provider: the payee's account id and the amount. Whether the amount is allowed is the domain's. */
export const PayThroughProviderBodySchema = {
  type: 'object',
  required: ['to', 'amount'],
  properties: {
    to: { type: 'string' },
    amount: { type: 'integer' },
  },
} as const;

export const PayThroughProviderResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  400: RefusedSchema,
  401: RefusedSchema,
} as const;

/** A refund is asked at once and answered later, as a command is; a refusal is the operation's error (request 15). */
export const RefundSettlementResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

/** The body of setting a payout account: the provider's id of the account. Whether the provider knows it is the domain's. */
export const SetPayoutAccountBodySchema = {
  type: 'object',
  required: ['accountId'],
  properties: {
    accountId: { type: 'string' },
  },
} as const;

/** Setting a payout account is asked at once and answered later, as a command is; a refusal is the operation's error (request 16). */
export const SetPayoutAccountResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  400: RefusedSchema,
  401: RefusedSchema,
} as const;

/** A person's payout account as they read it: the provider's id of the account they are paid on (request 16). */
export const GetPayoutAccountResSchema = {
  200: {
    type: 'object',
    required: ['accountId'],
    properties: { accountId: { type: 'string' } },
  },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/** The provider's webhook is acknowledged once its signature is right, whatever it says (ADR 8). */
export const ProviderWebhookResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

/** One line of a settlement's history: a status it has had, and when Tally learned it (request 19). */
const SettlementStatusLineSchema = {
  type: 'object',
  required: ['status', 'at'],
  properties: {
    status: { enum: ['pending', 'paid', 'failed', 'refunding', 'refunded'] },
    at: { type: 'string' },
  },
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
    method: { enum: ['cash', 'provider'] },
    status: { enum: ['pending', 'paid', 'failed', 'refunding', 'refunded'] },
    at: { type: 'string' },
    history: { type: 'array', minItems: 1, items: SettlementStatusLineSchema },
    payUrl: { type: 'string', minLength: 1 },
  },
  allOf: [
    {
      if: { required: ['method'], properties: { method: { const: 'provider' } } },
      then: { required: ['payUrl'] },
    },
  ],
} as const;

/** A settlement as a member of its group reads it. */
export const GetSettlementResSchema = {
  200: SettlementSchema,
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/** The settlements of a group, the most recently recorded first, as a member of the group reads them (request 19). */
export const GetGroupSettlementsResSchema = {
  200: { type: 'array', items: SettlementSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
