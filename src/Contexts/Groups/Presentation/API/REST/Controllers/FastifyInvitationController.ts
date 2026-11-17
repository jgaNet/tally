import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommandAtOnce, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { AcceptInvitationCommandEvent } from '@Contexts/Groups/Application/Commands';
import { GetInvitationQueryHandler } from '@Contexts/Groups/Application/Queries';

/** The routes of invitations: a signed-in person reads the invitation whose link they hold, and joins by it. */
export class FastifyInvitationController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getInvitation(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetInvitationQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  acceptInvitation(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      AcceptInvitationCommandEvent.set({ invitationId: req.params.id }),
    );
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { type: error.type, message: error.message };
  }
}
