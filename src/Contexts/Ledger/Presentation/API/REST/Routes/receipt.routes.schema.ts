import { RefusedSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

/** An expense's receipt as a member reads it: its type, its size in bytes, and the link the store reads it at (request 26). */
const ReceiptSchema = {
  type: 'object',
  required: ['type', 'size', 'url'],
  properties: {
    type: { enum: ['image/jpeg', 'image/png'] },
    size: { type: 'integer', minimum: 1, maximum: 2097152 },
    url: { type: 'string', minLength: 1 },
  },
} as const;

/** The file is not described here: whether it is a JPEG or a PNG of at most 2 MB is the domain's to decide, behind the 202. */
export const AttachReceiptResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

export const GetReceiptResSchema = {
  200: ReceiptSchema,
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
