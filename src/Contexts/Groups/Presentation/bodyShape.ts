import { FastifyReply, FastifyRequest } from 'fastify';

const SHAPE_REFUSAL = 'The body must have these fields, each a string';

/**
 * The shape of a body, checked on the raw request before the schema coerces it: a field missing or not a string is a
 * refusal of its shape, at once, with 400 (API-BODY-SHAPE). Whether the values are allowed is the use case's to say.
 */
export const shapeOf =
  (fields: string[]) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const body: unknown = request.body;
    const ok =
      typeof body === 'object' &&
      body !== null &&
      fields.every(field => typeof (body as Record<string, unknown>)[field] === 'string');
    if (!ok) return reply.code(400).send({ message: `${SHAPE_REFUSAL}: ${fields.join(', ')}` });
    return undefined;
  };
