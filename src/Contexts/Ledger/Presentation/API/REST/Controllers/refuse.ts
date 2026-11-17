import { FastifyReply } from 'fastify';
import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';

/** The status and the body of a refusal a query answers at once: 401 for a caller not signed in, 404 for what does not exist for them, 400 otherwise. */
export function refuse(reply: FastifyReply, error: Exception) {
  if (error instanceof NotAllowedException) reply.code(401);
  else if (error instanceof NotFoundException) reply.code(404);
  else reply.code(400);
  return { message: error.message };
}
