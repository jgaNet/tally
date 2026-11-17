const RefusedSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

export const SignUpBodySchema = {
  type: 'object',
  required: ['email', 'password', 'name'],
  properties: {
    email: { type: 'string' },
    password: { type: 'string' },
    name: { type: 'string' },
  },
} as const;

export const SignUpResSchema = {
  202: { description: 'Accepted', type: 'object', properties: { operationId: { type: 'string' } } },
  401: RefusedSchema,
} as const;

export const LoginBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string' },
    password: { type: 'string' },
  },
} as const;

export const LoginResSchema = {
  200: { description: 'Signed in', type: 'object', properties: { token: { type: 'string' } } },
  401: RefusedSchema,
} as const;

export const GetMyAccountResSchema = {
  200: {
    description: 'Success',
    type: 'object',
    properties: { id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' } },
  },
  401: RefusedSchema,
  404: RefusedSchema,
} as const;
