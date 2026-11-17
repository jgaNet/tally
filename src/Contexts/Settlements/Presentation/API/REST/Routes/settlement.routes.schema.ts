const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** A suggested transfer, as the API answers it (request 11's `transfer` resource). */
const TransferSchema = {
  type: 'object',
  required: ['from', 'to', 'amount'],
  properties: { from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'integer' } },
} as const;

export const GetSuggestedSettlementsResSchema = {
  200: { type: 'array', items: TransferSchema },
  401: RefusalSchema,
  404: RefusalSchema,
} as const;

/** The body of a cash settlement: who paid the payee, and how much (request 12). Its values are the domain's to decide. */
export interface RecordCashSettlementBody {
  from: string;
  amount: number;
}

export const RecordCashSettlementReqBodySchema = {
  type: 'object',
  required: ['from', 'amount'],
  properties: { from: { type: 'string' }, amount: { type: 'integer' } },
} as const;

export const RecordCashSettlementResSchema = {
  201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  202: { type: 'object', required: ['operationId'], properties: { operationId: { type: 'string' } } },
  400: RefusalSchema,
  401: RefusalSchema,
  404: RefusalSchema,
  409: RefusalSchema,
} as const;

/** A settlement as the API answers it to a member of its group (request 12's `settlement` resource). */
const SettlementSchema = {
  type: 'object',
  required: ['id', 'groupId', 'from', 'to', 'amount', 'method', 'status', 'at'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    amount: { type: 'integer', minimum: 1 },
    method: { enum: ['cash'] },
    status: { enum: ['paid'] },
    at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]00:?00)$' },
  },
} as const;

export const GetSettlementResSchema = {
  200: SettlementSchema,
  401: RefusalSchema,
  404: RefusalSchema,
} as const;
