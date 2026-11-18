import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommandAtOnce, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { DeleteAccountCommandEvent, SignUpCommandEvent, SignUpPayload } from '@Contexts/Groups/Application/Commands';
import { GetMyAccountQueryHandler, SignInQueryHandler } from '@Contexts/Groups/Application/Queries';

/** The routes of accounts: a sign-up answered at once, a sign-in and a read answered at once. */
export class FastifyAccountController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  signUp(req: FastifyRequest<{ Body: SignUpPayload }>, reply: FastifyReply) {
    return acceptCommandAtOnce(req, reply, this.#module, SignUpCommandEvent.set(req.body));
  }

  deleteMe(req: FastifyRequest, reply: FastifyReply) {
    return acceptCommandAtOnce(req, reply, this.#module, DeleteAccountCommandEvent.set({}));
  }

  async signIn(req: FastifyRequest<{ Body: { email: string; password: string } }>, reply: FastifyReply) {
    const result = await this.#module.getQuery(SignInQueryHandler).handle(req.body, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  async getMyAccount(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetMyAccountQueryHandler).handle(undefined, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { type: error.type, message: error.message };
  }
}
