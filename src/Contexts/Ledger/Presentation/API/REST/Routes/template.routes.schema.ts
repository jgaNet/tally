import { RefusedSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

/*
 * A template's split: exactly one of its two fields (request 25). Each with its own shape; two of them in one body, or none,
 * is the body's shape and a 400. Whether the members are members of the group, or the shares at least 1, is the domain's.
 */
const TemplateSplitFields = {
  splitBetween: { type: 'array', items: { type: 'string' } },
  splitByShares: {
    type: 'array',
    items: {
      type: 'object',
      required: ['memberId', 'shares'],
      properties: { memberId: { type: 'string' }, shares: { type: 'integer' } },
    },
  },
} as const;

const ExactlyOneOfTheTemplateSplits = [{ required: ['splitBetween'] }, { required: ['splitByShares'] }] as const;

/** The shape of a template as it is saved or replaced: its name (whose length is the domain's to decide) and its split. */
const TemplateBodySchema = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' }, ...TemplateSplitFields },
  allOf: [{ oneOf: ExactlyOneOfTheTemplateSplits }],
} as const;

export const SaveTemplateBodySchema = TemplateBodySchema;
export const ReplaceTemplateBodySchema = TemplateBodySchema;

export const SaveTemplateResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  400: RefusedSchema,
  401: RefusedSchema,
} as const;

export const ReplaceTemplateResSchema = SaveTemplateResSchema;

export const RemoveTemplateResSchema = {
  202: { type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

/** A template as a member reads it: its split as it was given, one of the two fields. */
const TemplateSchema = {
  type: 'object',
  required: ['id', 'groupId', 'name'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    name: { type: 'string' },
    ...TemplateSplitFields,
  },
} as const;

/** The group's templates, the earliest saved first. */
export const GetGroupTemplatesResSchema = {
  200: { type: 'array', items: TemplateSchema },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
