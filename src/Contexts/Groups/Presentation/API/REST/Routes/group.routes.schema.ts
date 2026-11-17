/** A refusal, named by the rule that refused it (`type`) and said in a sentence (`message`). */
const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

const IdSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
} as const;

/** A group as the API answers it (request 2's `group` resource). */
const GroupSchema = {
  type: 'object',
  required: ['id', 'name', 'currency', 'ownerId'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    currency: { enum: ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] },
    ownerId: { type: 'string' },
  },
} as const;

export const CreateGroupReqBodySchema = {
  type: 'object',
  required: ['name', 'currency'],
  properties: {
    name: { type: 'string' },
    currency: { type: 'string' },
  },
} as const;

export const CreateGroupResSchema = {
  201: IdSchema,
  202: {
    type: 'object',
    required: ['operationId'],
    properties: { operationId: { type: 'string' } },
  },
  400: RefusalSchema,
  401: RefusalSchema,
} as const;

export const GetGroupResSchema = {
  200: GroupSchema,
  401: RefusalSchema,
  404: RefusalSchema,
} as const;

export const GetMyGroupsResSchema = {
  200: { type: 'array', items: GroupSchema },
  401: RefusalSchema,
} as const;
