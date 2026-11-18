const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

/** The body of a change: whether the kind is turned on (`true`) or off (`false`). Whether the kind is one of the three is the preferences' to say. */
export const SetNoticePreferenceBodySchema = {
  type: 'object',
  required: ['enabled'],
  properties: { enabled: { type: 'boolean' } },
} as const;

/** A command answered later: 202 with an operation, read at `/operations` (request 1). */
export const LaterNoticePreferenceResSchema = {
  202: { description: 'Accepted', type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

/** A read: the signed-in person's kinds of notice, in order, each on or off. */
export const GetNoticePreferencesResSchema = {
  200: {
    description: 'Success',
    type: 'array',
    items: {
      type: 'object',
      required: ['kind', 'enabled'],
      properties: {
        kind: { enum: ['expense', 'reminder', 'budget'] },
        enabled: { type: 'boolean' },
      },
    },
  },
  401: RefusedSchema,
} as const;
