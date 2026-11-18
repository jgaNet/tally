/** A refusal, named by the rule that refused it (`type`) and said in a sentence (`message`). */
const RefusalSchema = {
  type: 'object',
  properties: { type: { type: 'string' }, message: { type: 'string' } },
} as const;

const IdSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
} as const;

export const SignUpReqBodySchema = {
  type: 'object',
  required: ['email', 'password', 'name'],
  properties: {
    email: { type: 'string' },
    password: { type: 'string' },
    name: { type: 'string' },
  },
} as const;

export const SignUpResSchema = {
  201: IdSchema,
  202: {
    type: 'object',
    required: ['operationId'],
    properties: { operationId: { type: 'string' } },
  },
  400: RefusalSchema,
  401: RefusalSchema,
  409: RefusalSchema,
} as const;

export const SignInReqBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string' },
    password: { type: 'string' },
  },
} as const;

export const SignInResSchema = {
  200: {
    type: 'object',
    required: ['token'],
    properties: { token: { type: 'string' } },
  },
  401: RefusalSchema,
} as const;

export const AccountResSchema = {
  200: {
    type: 'object',
    required: ['id', 'email', 'name'],
    properties: {
      id: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
    },
  },
  401: RefusalSchema,
  404: RefusalSchema,
} as const;

/** Deleting an account is answered at once with its id, or later with an operation; a refusal is named by its rule (request 35). */
export const DeleteAccountResSchema = {
  201: IdSchema,
  202: {
    type: 'object',
    required: ['operationId'],
    properties: { operationId: { type: 'string' } },
  },
  401: RefusalSchema,
  404: RefusalSchema,
  409: RefusalSchema,
} as const;
