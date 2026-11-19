import { FastifyReply, FastifyRequest } from 'fastify';
import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { Module } from '@Architecture/Application';
import { notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';
import { GetAdministratorsLogQueryHandler } from '@Contexts/Groups/Application/Queries';

export class FastifyAdminController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  /** An administrator reads the administrators' log: 401 to a caller not signed in, 404 to one who is not an administrator (request 33). */
  async getAdministratorsLog(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetAdministratorsLogQueryHandler)
      .handle(undefined, req.executionContext);
    if (result.isFailure()) {
      const error: Exception = result.error;
      if (error instanceof NotAllowedException) reply.code(notAllowedStatus(req.executionContext));
      else if (error instanceof NotFoundException) reply.code(404);
      else reply.code(400);
      return { message: error.message };
    }
    return result.data;
  }
}
