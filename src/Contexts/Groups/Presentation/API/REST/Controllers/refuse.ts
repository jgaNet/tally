import { FastifyReply } from 'fastify';
import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext } from '@Architecture/Application';
import { notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

/**
 * The status and the body of a refusal a query answers at once: 401 for a caller not signed in, 404 for what does not exist for them, 400
 * otherwise. Given the caller's context, a refusal of the rule itself (NotAllowed) answers 403 to a signed-in caller (request 33).
 */
export function refuse(reply: FastifyReply, error: Exception, context?: ExecutionContext) {
  if (error instanceof NotAllowedException) reply.code(context ? notAllowedStatus(context) : 401);
  else if (error instanceof NotFoundException) reply.code(404);
  else reply.code(400);
  return { message: error.message };
}
