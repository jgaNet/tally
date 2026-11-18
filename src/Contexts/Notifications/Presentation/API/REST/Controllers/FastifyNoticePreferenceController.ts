import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommandAtOnce, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { GetNoticePreferencesQueryHandler } from '@Contexts/Notifications/Application/Queries';
import { SetNoticePreferenceCommandEvent } from '@Contexts/Notifications/Application/Commands';
import { SetNoticePreferenceBody } from '@Contexts/Notifications/Presentation/API/REST/Routes/notice-preference.routes.schema';

/** The routes of notice preferences: a signed-in person turns each kind of notice on or off, and reads each (request 36). */
export class FastifyNoticePreferenceController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  setNoticePreference(
    req: FastifyRequest<{ Params: { kind: string }; Body: SetNoticePreferenceBody }>,
    reply: FastifyReply,
  ) {
    return acceptCommandAtOnce(
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

    return { type: error.type, message: error.message };
  }
}
