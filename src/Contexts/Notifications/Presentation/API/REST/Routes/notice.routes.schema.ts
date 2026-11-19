export const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

/** A notice: an expense's names its expense; a reminder's has none (request 18); a budget's names its category, month and budget (request 24). */
const NoticeSchema = {
  type: 'object',
  required: ['id', 'kind', 'groupId', 'amount', 'at'],
  properties: {
    id: { type: 'string' },
    kind: { enum: ['expense', 'reminder', 'budget'] },
    groupId: { type: 'string' },
    expenseId: { type: 'string' },
    amount: { type: 'integer' },
    at: { type: 'string' },
    category: { enum: ['groceries', 'rent', 'utilities', 'transport', 'food', 'travel', 'leisure', 'other'] },
    month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    budget: { type: 'integer', minimum: 1 },
  },
} as const;

/** A person's notice preferences, the three kinds in the order they are read (request 36). */
export const GetNoticePreferencesResSchema = {
  200: {
    type: 'array',
    items: {
      type: 'object',
      required: ['kind', 'enabled'],
      properties: { kind: { enum: ['expense', 'reminder', 'budget'] }, enabled: { type: 'boolean' } },
    },
  },
  401: RefusedSchema,
} as const;

/** A person turns a kind of notice on or off: asked at once, answered later as an operation (request 36). */
export const SetNoticePreferenceResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

/** The body of a change: whether the kind is on (request 36). */
export const SetNoticePreferenceBodySchema = {
  type: 'object',
  required: ['enabled'],
  properties: { enabled: { type: 'boolean' } },
} as const;

/** A person's notices, the most recent first. */
export const GetMyNoticesResSchema = {
  200: { type: 'array', items: NoticeSchema },
  401: RefusedSchema,
} as const;
