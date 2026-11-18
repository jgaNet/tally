import { CURRENCIES } from '@SharedKernel/Domain/Currency';

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
    currency: { enum: [...CURRENCIES] },
    ownerId: { type: 'string' },
    /** Present only on an archived group, when it was archived (request 27). */
    archivedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]00:?00)$' },
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

/** A member of a group as the API answers it (request 3's `member` resource). */
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

export const CreateInvitationResSchema = {
  201: IdSchema,
  202: {
    type: 'object',
    required: ['operationId'],
    properties: { operationId: { type: 'string' } },
  },
  400: RefusalSchema,
  401: RefusalSchema,
  404: RefusalSchema,
} as const;

export const GetGroupMembersResSchema = {
  200: { type: 'array', items: MemberSchema },
  401: RefusalSchema,
  404: RefusalSchema,
} as const;

/** Leaving answers at once, as a creation does: the id of the group left, or the refusal (request 9). */
export const LeaveGroupResSchema = {
  201: IdSchema,
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

/** Archiving answers at once, as leaving does: the id of the group archived, or the refusal (request 27). */
export const ArchiveGroupResSchema = {
  201: IdSchema,
  202: {
    type: 'object',
    required: ['operationId'],
    properties: { operationId: { type: 'string' } },
  },
  400: RefusalSchema,
  401: RefusalSchema,
  403: RefusalSchema,
  404: RefusalSchema,
  409: RefusalSchema,
} as const;

/** Merging answers at once, as archiving does: the id of the group kept, or the refusal (request 31). */
export const MergeGroupReqBodySchema = {
  type: 'object',
  required: ['from'],
  properties: { from: { type: 'string', minLength: 1 } },
} as const;

export const MergeGroupResSchema = {
  201: IdSchema,
  202: {
    type: 'object',
    required: ['operationId'],
    properties: { operationId: { type: 'string' } },
  },
  400: RefusalSchema,
  401: RefusalSchema,
  403: RefusalSchema,
  404: RefusalSchema,
  409: RefusalSchema,
} as const;

/** Suspending and reinstating answer at once, as leaving does: the id of the account, or the refusal (request 34). */
export const SuspensionResSchema = {
  201: IdSchema,
  202: {
    type: 'object',
    required: ['operationId'],
    properties: { operationId: { type: 'string' } },
  },
  400: RefusalSchema,
  401: RefusalSchema,
  403: RefusalSchema,
  404: RefusalSchema,
} as const;

/** The administrators' log, the oldest first: administrators only (request 33). */
export const GetAdministratorsLogResSchema = {
  200: {
    type: 'array',
    items: {
      type: 'object',
      required: ['id', 'at', 'by', 'action', 'subjectId'],
      properties: {
        id: { type: 'string' },
        at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]00:?00)$' },
        by: { type: 'string' },
        action: { enum: ['decided-paid', 'decided-annulled', 'suspended', 'reinstated'] },
        subjectId: { type: 'string' },
      },
    },
  },
  401: RefusalSchema,
  404: RefusalSchema,
} as const;
