import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { GetMyInsightsQueryHandler } from '@Contexts/Ledger/Application/Queries';

export class FastifyInsightController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getInsights(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetMyInsightsQueryHandler).handle(undefined, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else reply.code(400);

    return { message: error.message };
  }
}
