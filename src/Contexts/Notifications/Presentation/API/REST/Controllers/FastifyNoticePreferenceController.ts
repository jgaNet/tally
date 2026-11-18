import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommand, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { SetNoticePreferenceCommandEvent } from '@Contexts/Notifications/Application/Commands/SetNoticePreference';
import { GetNoticePreferencesQueryHandler } from '@Contexts/Notifications/Application/Queries/GetNoticePreferences';

export class FastifyNoticePreferenceController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async setNoticePreference(
    req: FastifyRequest<{ Params: { kind: string }; Body: { enabled: boolean } }>,
    reply: FastifyReply,
  ) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      SetNoticePreferenceCommandEvent.set({ kind: req.params.kind, enabled: req.body.enabled }),
    );
  }

  async getNoticePreferences(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetNoticePreferencesQueryHandler)
      .handle(undefined, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else reply.code(400);

    return { message: error.message };
  }
}
