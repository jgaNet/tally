import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommandAtOnce, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { CreateGroupCommandEvent, CreateGroupPayload } from '@Contexts/Groups/Application/Commands';
import { GetGroupQueryHandler, GetMyGroupsQueryHandler } from '@Contexts/Groups/Application/Queries';

/** The routes of groups: a creation answered at once, and two reads of the caller's own groups. */
export class FastifyGroupController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  createGroup(req: FastifyRequest<{ Body: CreateGroupPayload }>, reply: FastifyReply) {
    return acceptCommandAtOnce(req, reply, this.#module, CreateGroupCommandEvent.set(req.body));
  }

  async getGroup(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  async getMyGroups(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetMyGroupsQueryHandler).handle(undefined, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { type: error.type, message: error.message };
  }
}
