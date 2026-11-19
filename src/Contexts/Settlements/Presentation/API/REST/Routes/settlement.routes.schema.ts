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

/** The payee contests a settlement paid through the provider: asked at once and answered later, as a refund is (request 33). */
export const ContestSettlementResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

/** The body of an administrator's decision on a contested settlement: `paid` is true when the money arrived (request 33). */
export const DecideContestBodySchema = {
  type: 'object',
  required: ['paid'],
  properties: {
    paid: { type: 'boolean' },
  },
} as const;

/** A decision is asked at once and answered later; a refusal of the rule is the operation's error (request 33). */
export const DecideContestResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  400: RefusedSchema,
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
    status: { enum: ['pending', 'paid', 'failed', 'refunding', 'refunded', 'contested', 'annulled'] },
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
    method: { enum: ['cash', 'provider', 'net'] },
    status: { enum: ['pending', 'paid', 'failed', 'refunding', 'refunded', 'contested', 'annulled'] },
    at: { type: 'string' },
    history: { type: 'array', minItems: 1, items: SettlementStatusLineSchema },
    payUrl: { type: 'string', minLength: 1 },
    fee: {
      type: 'object',
      required: ['amount', 'borneBy'],
      properties: {
        amount: { type: 'integer', minimum: 0 },
        borneBy: { enum: ['payer', 'payee', 'shared'] },
      },
    },
  },
  allOf: [
    {
      if: { required: ['method'], properties: { method: { const: 'provider' } } },
      then: { required: ['payUrl'] },
    },
    {
      // Only a settlement through the provider has a fee (request 38).
      if: { required: ['fee'] },
      then: { properties: { method: { const: 'provider' } } },
    },
  ],
} as const;

/** A settlement as a member of its group reads it. */
export const GetSettlementResSchema = {
  200: SettlementSchema,
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/** The settlements contested now, the earliest contested first; 401 for a caller not signed in, 404 for one who is not an administrator (request 33). */
export const GetContestsResSchema = {
  200: { type: 'array', items: SettlementSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/** The settlements of a group, the most recently recorded first, as a member of the group reads them (request 19). */
export const GetGroupSettlementsResSchema = {
  200: { type: 'array', items: SettlementSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/** The body of a netting: the other member's account id and the currency. Whether the currency is Tally's is the domain's (request 32). */
export const NetDebtsBodySchema = {
  type: 'object',
  required: ['with', 'currency'],
  properties: {
    with: { type: 'string' },
    currency: { type: 'string' },
  },
} as const;

export const NetDebtsResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  400: RefusedSchema,
  401: RefusedSchema,
} as const;

/** A netting as the two people read it: who asked, with whom, its currency, the amount netted, and its settlements in order (request 32). */
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

export const GetNettingResSchema = {
  200: NettingSchema,
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

/** The body of setting who bears the provider's fee: `payer`, `payee` or `shared`. Whether the value is one of them is the domain's (request 38). */
export const SetFeePolicyBodySchema = {
  type: 'object',
  required: ['borneBy'],
  properties: {
    borneBy: { type: 'string' },
  },
} as const;

/** Setting the fee policy is asked at once and answered later, as a command is; a refusal is the operation's error (request 38). */
export const SetFeePolicyResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  400: RefusedSchema,
  401: RefusedSchema,
} as const;

/** Who bears the provider's fee of a group: `payer`, `payee` or `shared` (request 38). */
export const GetFeePolicyResSchema = {
  200: {
    type: 'object',
    required: ['borneBy'],
    properties: { borneBy: { enum: ['payer', 'payee', 'shared'] } },
  },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
