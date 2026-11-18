const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

/** A command answered later: 202 with an operation, whose SUCCESS result is the receipt's id (request 1). */
export const LaterCommandResSchema = {
  202: { description: 'Accepted', type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

/** A read (request 26): the expense's receipt, to a member of its group; `404` when the expense has none. */
export const GetReceiptResSchema = {
  200: {
    description: 'Success',
    type: 'object',
    required: ['type', 'size', 'url'],
    properties: {
      type: { type: 'string', enum: ['image/jpeg', 'image/png'] },
      size: { type: 'integer', minimum: 1, maximum: 2097152 },
      url: { type: 'string', minLength: 1 },
    },
  },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
