const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

/** A read: the notices made for the signed-in person, the most recent first, and nobody else's. */
export const GetNoticesResSchema = {
  200: {
    description: 'Success',
    type: 'array',
    items: {
      type: 'object',
      required: ['id', 'kind', 'groupId', 'expenseId', 'amount', 'at'],
      properties: {
        id: { type: 'string' },
        kind: { enum: ['expense'] },
        groupId: { type: 'string' },
        expenseId: { type: 'string' },
        amount: { type: 'integer' },
        at: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]00:?00)$',
        },
      },
    },
  },
  401: RefusedSchema,
} as const;
