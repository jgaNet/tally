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
    // Present only once the group is archived (request 27).
    archivedAt: { type: 'string' },
  },
} as const;

const InvitationSchema = {
  type: 'object',
  required: ['id', 'groupId', 'groupName', 'invitedBy'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    groupName: { type: 'string' },
    invitedBy: { type: 'string' },
  },
} as const;

const MemberSchema = {
  type: 'object',
  required: ['memberId', 'name', 'role', 'joinedAt'],
  properties: {
    memberId: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', enum: ['owner', 'member'] },
    joinedAt: { type: 'string' },
  },
} as const;

/** The group merged into the group of the path, by its id (request 31). */
export const MergeGroupsBodySchema = {
  type: 'object',
  required: ['from'],
  properties: {
    from: { type: 'string' },
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

/** A command answered later (202 with an operation, the way request 2 answers): the operation's result says what it did. */
export const LaterCommandResSchema = CreateGroupResSchema;

export const GetInvitationResSchema = {
  200: { description: 'Success', ...InvitationSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

export const GetGroupMembersResSchema = {
  200: { description: 'Success', type: 'array', items: MemberSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
