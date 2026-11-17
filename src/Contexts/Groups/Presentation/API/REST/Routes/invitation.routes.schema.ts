const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
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

export const GetInvitationResSchema = {
  200: InvitationSchema,
  401: RefusedSchema,
  404: RefusedSchema,
} as const;

export const AcceptInvitationResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;
