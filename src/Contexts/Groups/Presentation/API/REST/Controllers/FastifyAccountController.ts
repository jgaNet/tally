import { FastifyReply, FastifyRequest } from 'fastify';
import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { Module } from '@Architecture/Application';
import { acceptCommand } from '@Architecture/Presentation/AcceptCommand';
import { SignUpCommandEvent } from '@Contexts/Groups/Application/Commands';
import { GetMyAccountQueryHandler, LoginQueryHandler } from '@Contexts/Groups/Application/Queries';
import { InvalidCredentials } from '@Contexts/Groups/Domain/Account/AccountExceptions';

export class FastifyAccountController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  signUp(req: FastifyRequest<{ Body: { email: string; password: string; name: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, SignUpCommandEvent.set(req.body));
  }

  async login(req: FastifyRequest<{ Body: { email: string; password: string } }>, reply: FastifyReply) {
    const result = await this.#module.getQuery(LoginQueryHandler).handle(req.body, req.executionContext);
    return result.isFailure() ? this.refuse(reply, result.error) : result.data;
  }

  async getMyAccount(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetMyAccountQueryHandler).handle(undefined, req.executionContext);
    return result.isFailure() ? this.refuse(reply, result.error) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception) {
    if (error instanceof InvalidCredentials || error instanceof NotAllowedException) reply.code(401);
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);
    return { message: error.message };
  }
}
