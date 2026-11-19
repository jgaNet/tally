import { CURRENCY_CODES } from '@SharedKernel/Domain';
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
    currency: { enum: [...CURRENCY_CODES] },
    ownerId: { type: 'string' },
    archivedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]00:?00)$' },
  },
} as const;

const MemberSchema = {
  type: 'object',
  required: ['memberId', 'name', 'role', 'joinedAt'],
  properties: {
    memberId: { type: 'string' },
    name: { type: 'string' },
    role: { enum: ['owner', 'member'] },
    joinedAt: { type: 'string' },
  },
} as const;

/** The shape of each body: a field missing or of the wrong type is a 400; what a value may be is the domain's. */
export const CreateGroupBodySchema = {
  type: 'object',
  required: ['name', 'currency'],
  properties: {
    name: { type: 'string' },
    currency: { type: 'string' },
  },
} as const;

export const CreateGroupResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  400: RefusedSchema,
  401: RefusedSchema,
} as const;

export const GetGroupResSchema = {
  200: GroupSchema,
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

export const GetMyGroupsResSchema = {
  200: { type: 'array', items: GroupSchema },
  401: RefusedSchema,
} as const;

export const CreateInvitationResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

export const GetGroupMembersResSchema = {
  200: { type: 'array', items: MemberSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

export const LeaveGroupResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

export const ArchiveGroupResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

/** The body of a merge (request 31): the group merged, by its id; whether it may be merged is the domain's. */
export const MergeGroupsBodySchema = {
  type: 'object',
  required: ['from'],
  properties: {
    from: { type: 'string' },
  },
} as const;

export const MergeGroupsResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  400: RefusedSchema,
  401: RefusedSchema,
} as const;
