import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { GetMyNoticesQueryHandler } from '@Contexts/Notifications/Application/Queries';

/** The routes of notices: a signed-in person lists their own notices, the most recent first (request 17). */
export class FastifyNoticeController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getMyNotices(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetMyNoticesQueryHandler).handle(undefined, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else reply.code(400);

    return { type: error.type, message: error.message };
  }
}
