import { FastifyReply, FastifyRequest } from 'fastify';
import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { Module } from '@Architecture/Application';
import { acceptCommand, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';
import { GetAdministratorsLogQueryHandler } from '@Contexts/Groups/Application/Queries';
import { SuspendAccountCommandEvent } from '@Contexts/Groups/Application/Commands/SuspendAccount/SuspendAccountCommandEvent';
import { ReinstateAccountCommandEvent } from '@Contexts/Groups/Application/Commands/ReinstateAccount/ReinstateAccountCommandEvent';

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

  /** An administrator suspends an account (request 34): asked at once, answered later as an operation. */
  suspendAccount(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, SuspendAccountCommandEvent.set({ accountId: req.params.id }));
  }

  /** An administrator reinstates an account (request 34): asked at once, answered later as an operation. */
  reinstateAccount(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, ReinstateAccountCommandEvent.set({ accountId: req.params.id }));
  }
}
