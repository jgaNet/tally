import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { acceptCommand } from '@Architecture/Presentation/AcceptCommand';
import { AcceptInvitationCommandEvent } from '@Contexts/Groups/Application/Commands';
import { GetInvitationQueryHandler } from '@Contexts/Groups/Application/Queries';
import { refuse } from '@Contexts/Groups/Presentation/API/REST/Controllers/refuse';

export class FastifyInvitationController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getInvitation(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetInvitationQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }

  acceptInvitation(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, AcceptInvitationCommandEvent.set({ invitationId: req.params.id }));
  }
}
