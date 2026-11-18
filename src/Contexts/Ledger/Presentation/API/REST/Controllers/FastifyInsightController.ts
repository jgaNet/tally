import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { GetMyInsightsQueryHandler } from '@Contexts/Ledger/Application/Queries/GetMyInsights/GetMyInsightsQueryHandler';

/** The route of a person's spending: a signed-in person reads their own, across their groups (request 37). */
export class FastifyInsightController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getMyInsights(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetMyInsightsQueryHandler).handle(undefined, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { type: error.type, message: error.message };
  }
}
