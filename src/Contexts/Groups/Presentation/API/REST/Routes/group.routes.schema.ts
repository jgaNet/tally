const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

const GroupSchema = {
  type: 'object',
  required: ['id', 'name', 'currency', 'ownerId'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    currency: { type: 'string' },
    ownerId: { type: 'string' },
  },
} as const;

export const CreateGroupBodySchema = {
  type: 'object',
  required: ['name', 'currency'],
  properties: {
    name: { type: 'string' },
    currency: { type: 'string' },
  },
} as const;

export const CreateGroupResSchema = {
  202: { description: 'Accepted', type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

export const GetGroupResSchema = {
  200: { description: 'Success', ...GroupSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

export const GetMyGroupsResSchema = {
  200: { description: 'Success', type: 'array', items: GroupSchema },
  401: RefusedSchema,
} as const;
