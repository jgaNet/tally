const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

const TransferSchema = {
  type: 'object',
  required: ['from', 'to', 'amount'],
  properties: { from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'integer', minimum: 1 } },
} as const;

/** A read: the transfers that would bring every balance of the group to 0, in the order made, to a member of the group only. */
export const GetSuggestedSettlementsResSchema = {
  200: { description: 'Success', type: 'array', items: TransferSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
