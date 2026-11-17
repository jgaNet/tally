import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommand, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { SetPayoutAccountCommandEvent } from '@Contexts/Settlements/Application/Commands/SetPayoutAccount';
import { GetPayoutAccountQueryHandler } from '@Contexts/Settlements/Application/Queries/GetPayoutAccount';

export class FastifyPayoutAccountController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async setPayoutAccount(req: FastifyRequest<{ Body: { accountId: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, SetPayoutAccountCommandEvent.set({ accountId: req.body.accountId }));
  }

  async getPayoutAccount(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetPayoutAccountQueryHandler).handle(undefined, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { message: error.message };
  }
}
