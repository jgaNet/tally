import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { NotAllowedException, Exception } from '@Architecture/Domain';
import { GetMyNoticesQueryHandler } from '@Contexts/Notifications/Application/Queries';

export class FastifyNoticeController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getMyNotices(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetMyNoticesQueryHandler).handle(undefined, req.executionContext);
    if (result.isFailure()) return refuse(reply, result.error);
    return result.data;
  }
}

/** A caller not signed in answers 401; anything else the query refuses answers 400. */
function refuse(reply: FastifyReply, error: Exception) {
  reply.code(error instanceof NotAllowedException ? 401 : 400);
  return { message: error.message };
}
