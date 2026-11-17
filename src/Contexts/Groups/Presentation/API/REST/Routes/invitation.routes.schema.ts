const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** An invitation as the API answers it to a signed-in person who holds its link (request 3's `invitation` resource). */
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

export const GetInvitationResSchema = {
  200: InvitationSchema,
  401: RefusalSchema,
  404: RefusalSchema,
} as const;

/** Joining answers the id of the group joined, at once. */
export const AcceptInvitationResSchema = {
  201: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  202: {
    type: 'object',
    required: ['operationId'],
    properties: { operationId: { type: 'string' } },
  },
  400: RefusalSchema,
  401: RefusalSchema,
  404: RefusalSchema,
  409: RefusalSchema,
} as const;
