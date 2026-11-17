import { FastifyReply, FastifyRequest } from 'fastify';
import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { Module } from '@Architecture/Application';
import { acceptCommand } from '@Architecture/Presentation/AcceptCommand';
import { CreateGroupCommandEvent } from '@Contexts/Groups/Application/Commands';
import { GetGroupQueryHandler, GetMyGroupsQueryHandler } from '@Contexts/Groups/Application/Queries';

export class FastifyGroupController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  createGroup(req: FastifyRequest<{ Body: { name: string; currency: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, CreateGroupCommandEvent.set(req.body));
  }

  async getGroup(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);
    return result.isFailure() ? this.refuse(reply, result.error) : result.data;
  }

  async getMyGroups(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetMyGroupsQueryHandler).handle(undefined, req.executionContext);
    return result.isFailure() ? this.refuse(reply, result.error) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception) {
    if (error instanceof NotAllowedException) reply.code(401);
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);
    return { message: error.message };
  }
}
