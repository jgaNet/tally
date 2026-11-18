import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { GetGroupAuditQueryHandler } from '@Contexts/Ledger/Application/Queries';

export class FastifyAuditController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getAudit(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupAuditQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { message: error.message };
  }
}
