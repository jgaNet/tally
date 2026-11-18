const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

/** The shares of a member in a split by shares: a whole number; whether it is at least 1 is the template's to decide, behind the 202. */
const MemberSharesSchema = {
  type: 'object',
  required: ['memberId', 'shares'],
  properties: { memberId: { type: 'string' }, shares: { type: 'integer' } },
} as const;

/**
 * The body of a template: its name, and its split, equally between members or by shares, exactly one of the two (request 25). Each is
 * listed by shape only; whether the name is 1 to 60 characters, the members are the group's and each is listed once is the template's to
 * decide, behind the 202. A split by exact amounts makes no template, so such a body is of the wrong shape (400).
 */
export const TemplateBodySchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
    splitBetween: { type: 'array', items: { type: 'string' } },
    splitByShares: { type: 'array', items: MemberSharesSchema },
  },
  oneOf: [{ required: ['splitBetween'] }, { required: ['splitByShares'] }],
  not: { required: ['splitExactly'] },
} as const;

/** A command answered later: 202 with an operation, whose SUCCESS result is the template's id (request 1). */
export const LaterCommandResSchema = {
  202: { description: 'Accepted', type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

/** A read (request 25): the group's templates, the earliest saved first, to a member of the group only. */
export const GetTemplatesResSchema = {
  200: {
    description: 'Success',
    type: 'array',
    items: {
      type: 'object',
      required: ['id', 'groupId', 'name'],
      properties: {
        id: { type: 'string' },
        groupId: { type: 'string' },
        name: { type: 'string' },
        splitBetween: { type: 'array', items: { type: 'string' } },
        splitByShares: { type: 'array', items: MemberSharesSchema },
      },
    },
  },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
