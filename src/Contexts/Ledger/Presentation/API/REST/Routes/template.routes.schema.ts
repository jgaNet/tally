const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

/** The body of a template saved or replaced: a name, and exactly one of the two splits a template keeps (request 25). */
export interface TemplateBody {
  name: string;
  /** An equal split: the members' account ids, in the order given. */
  splitBetween?: string[];
  /** A split by shares: each member with a whole number of shares. */
  splitByShares?: { memberId: string; shares: number }[];
}

export const TemplateReqBodySchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
    splitBetween: { type: 'array', items: { type: 'string' } },
    splitByShares: {
      type: 'array',
      items: {
        type: 'object',
        required: ['memberId', 'shares'],
        properties: { memberId: { type: 'string' }, shares: { type: 'integer' } },
      },
    },
  },
  oneOf: [{ required: ['splitBetween'] }, { required: ['splitByShares'] }],
} as const;

const CommandResSchema = (success: object) => ({
  ...success,
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
});

/** Saving a template answers its id at once, or the refusal that named the rule it broke. */
export const SaveTemplateResSchema = CommandResSchema({
  201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
});

export const ReplaceTemplateResSchema = CommandResSchema({
  201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
});

export const RemoveTemplateResSchema = CommandResSchema({
  201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
});

/** A template as a member reads it: its id, its group, its name, and the split as it was given. */
const TemplateSchema = {
  type: 'object',
  required: ['id', 'groupId', 'name'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    name: { type: 'string' },
    splitBetween: { type: 'array', minItems: 1, items: { type: 'string' } },
    splitByShares: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['memberId', 'shares'],
        properties: { memberId: { type: 'string' }, shares: { type: 'integer', minimum: 1 } },
      },
    },
  },
} as const;

export const GetGroupTemplatesResSchema = {
  200: { type: 'array', items: TemplateSchema },
  401: RefusalSchema,
  404: RefusalSchema,
} as const;
