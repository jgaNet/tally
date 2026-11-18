import { NOTICE_KINDS } from '@Contexts/Notifications/Domain/NoticePreference/DTOs';

const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** The body of a notice preference: whether the kind is on (request 36). The kind is in the route. */
export interface SetNoticePreferenceBody {
  enabled: boolean;
}

/** The route's kind: one of the three kinds of notice (request 36's `noticePreference`); any other is refused by the transport. */
export const NoticePreferenceParamsSchema = {
  type: 'object',
  required: ['kind'],
  properties: { kind: { enum: [...NOTICE_KINDS] } },
} as const;

export const SetNoticePreferenceReqBodySchema = {
  type: 'object',
  required: ['enabled'],
  properties: { enabled: { type: 'boolean' } },
} as const;

export const SetNoticePreferenceResSchema = {
  201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  202: { type: 'object', required: ['operationId'], properties: { operationId: { type: 'string' } } },
  400: RefusalSchema,
  401: RefusalSchema,
  409: RefusalSchema,
} as const;

/** A person's notice preferences, each kind on or off, in the order the kinds are declared (request 36). */
export const GetNoticePreferencesResSchema = {
  200: {
    type: 'array',
    items: {
      type: 'object',
      required: ['kind', 'enabled'],
      properties: { kind: { type: 'string', enum: [...NOTICE_KINDS] }, enabled: { type: 'boolean' } },
    },
  },
  401: RefusalSchema,
} as const;
