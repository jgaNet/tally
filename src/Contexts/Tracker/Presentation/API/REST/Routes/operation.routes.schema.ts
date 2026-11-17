/**
 * An operation, as a client reads it (`GET /v1/operations/{operationId}`): its status, and once decided, its
 * result on success or its error (`type`, the rule's name, and `message`) on refusal. Nothing else of the
 * record is the client's: no trace, no caller, no name, no time.
 */
const OperationSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['PENDING', 'SUCCESS', 'ERROR'] },
    result: { description: 'What the handler returned, on success' },
    error: {
      type: 'object',
      required: ['type', 'message'],
      properties: { type: { type: 'string' }, message: { type: 'string' } },
    },
  },
} as const;

const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

export const GetOperationResSchema = {
  200: { description: 'Success', ...OperationSchema },
  400: RefusedSchema,
  401: RefusedSchema,
  403: RefusedSchema,
  404: RefusedSchema,
} as const;
