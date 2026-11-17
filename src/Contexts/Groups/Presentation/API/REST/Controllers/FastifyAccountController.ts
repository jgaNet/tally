import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommand, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { SignUpCommandEvent } from '@Contexts/Groups/Application/Commands';
import { GetMyAccountQueryHandler, LoginQueryHandler } from '@Contexts/Groups/Application/Queries';

export class FastifyAccountController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async signUp(req: FastifyRequest<{ Body: { email: string; password: string; name: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, SignUpCommandEvent.set(req.body));
  }

  async login(req: FastifyRequest<{ Body: { email: string; password: string } }>, reply: FastifyReply) {
    const result = await this.#module.getQuery(LoginQueryHandler).handle(req.body, req.executionContext);

    if (result.isFailure()) {
      // Whoever asks, the refusal is the same 401: nobody learns which emails have accounts.
      reply.code(401);
      return { message: result.error.message };
    }
    return { token: result.data };
  }

  async getMyAccount(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetMyAccountQueryHandler).handle(undefined, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { message: error.message };
  }
}
