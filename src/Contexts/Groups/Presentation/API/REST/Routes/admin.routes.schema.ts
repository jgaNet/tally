const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

/** A read: the administrators' log, every decision an administrator made, the oldest first, to an administrator only; anyone else is told it does not exist. */
export const GetAdministratorsLogResSchema = {
  200: {
    description: 'Success',
    type: 'array',
    items: {
      type: 'object',
      required: ['id', 'at', 'by', 'action', 'subjectId'],
      properties: {
        id: { type: 'string' },
        at: { type: 'string' },
        by: { type: 'string' },
        action: { type: 'string', enum: ['decided-paid', 'decided-annulled'] },
        subjectId: { type: 'string' },
      },
    },
  },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
