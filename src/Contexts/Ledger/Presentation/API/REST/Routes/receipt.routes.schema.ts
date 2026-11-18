import { LARGEST_RECEIPT_BYTES, RECEIPT_TYPES } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** A receipt as a member reads it: its type, its size in bytes, and the link the store keeps it at (request 26). */
export const ReceiptSchema = {
  type: 'object',
  required: ['type', 'size', 'url'],
  properties: {
    type: { enum: [...RECEIPT_TYPES] },
    size: { type: 'integer', minimum: 1, maximum: LARGEST_RECEIPT_BYTES },
    url: { type: 'string', minLength: 1 },
  },
} as const;

/** Attaching a receipt is answered at once: the receipt's id, or the refusal of its rule (request 26). */
export const AttachReceiptResSchema = {
  201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
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

export const GetReceiptResSchema = {
  200: ReceiptSchema,
  401: RefusalSchema,
  404: RefusalSchema,
} as const;
