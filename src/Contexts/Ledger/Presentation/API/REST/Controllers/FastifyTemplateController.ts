import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommandAtOnce, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { ReplaceTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/ReplaceTemplate/ReplaceTemplateCommandEvent';
import { RemoveTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/RemoveTemplate/RemoveTemplateCommandEvent';
import { SaveTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/SaveTemplate/SaveTemplateCommandEvent';
import { GetGroupTemplatesQueryHandler } from '@Contexts/Ledger/Application/Queries/GetGroupTemplates/GetGroupTemplatesQueryHandler';
import { TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { TemplateBody } from '@Contexts/Ledger/Presentation/API/REST/Routes/template.routes.schema';

/** The routes of split templates: a member saves one of their group, the member who saved it or the owner changes or removes it, and a member reads the group's (request 25). */
export class FastifyTemplateController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  saveTemplate(req: FastifyRequest<{ Params: { id: string }; Body: TemplateBody }>, reply: FastifyReply) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      SaveTemplateCommandEvent.set({ groupId: req.params.id, name: req.body.name, split: splitOf(req.body) }),
    );
  }

  replaceTemplate(req: FastifyRequest<{ Params: { id: string }; Body: TemplateBody }>, reply: FastifyReply) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      ReplaceTemplateCommandEvent.set({ templateId: req.params.id, name: req.body.name, split: splitOf(req.body) }),
    );
  }

  removeTemplate(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommandAtOnce(req, reply, this.#module, RemoveTemplateCommandEvent.set({ templateId: req.params.id }));
  }

  async getGroupTemplates(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupTemplatesQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { type: error.type, message: error.message };
  }
}

/** The split the body gives: exactly one of the two has been let through by the transport (request 25). */
const splitOf = (body: TemplateBody): TemplateSplit =>
  body.splitByShares
    ? { kind: 'shares', shares: body.splitByShares }
    : { kind: 'equal', memberIds: body.splitBetween ?? [] };
