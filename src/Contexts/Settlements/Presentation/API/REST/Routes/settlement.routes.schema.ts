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

/** The provider's webhook is acknowledged once its signature is right, whatever it says (ADR 8). */
export const ProviderWebhookResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
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
