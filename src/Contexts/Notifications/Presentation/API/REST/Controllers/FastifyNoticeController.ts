import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { NotAllowedException, Exception } from '@Architecture/Domain';
import { acceptCommand } from '@Architecture/Presentation/AcceptCommand';
import {
  GetMyNoticesQueryHandler,
  GetNoticePreferencesQueryHandler,
} from '@Contexts/Notifications/Application/Queries';
import { SetNoticePreferenceCommandEvent } from '@Contexts/Notifications/Application/Commands/SetNoticePreference';

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

  /** A person reads their own notice preferences (request 36): 401 to a caller not signed in. */
  async getNoticePreferences(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetNoticePreferencesQueryHandler)
      .handle(undefined, req.executionContext);
    if (result.isFailure()) return refuse(reply, result.error);
    return result.data;
  }

  /** A person turns a kind of notice on or off (request 36): asked at once, answered later as an operation. */
  setNoticePreference(
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
}

/** A caller not signed in answers 401; anything else the query refuses answers 400. */
function refuse(reply: FastifyReply, error: Exception) {
  reply.code(error instanceof NotAllowedException ? 401 : 400);
  return { message: error.message };
}
