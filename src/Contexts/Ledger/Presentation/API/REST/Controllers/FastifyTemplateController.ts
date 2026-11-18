import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommand, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { RemoveTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/RemoveTemplate';
import { ReplaceTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/ReplaceTemplate';
import { SaveTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/SaveTemplate';
import { GetGroupTemplatesQueryHandler } from '@Contexts/Ledger/Application/Queries';
import { TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateSplit';

/** Exactly one of the two ways to split a template, as a body gives it (request 25). */
type SplitBody = { splitBetween: string[] } | { splitByShares: { memberId: string; shares: number }[] };
type TemplateBody = { name: string } & SplitBody;

/** The split a body gives: the transport has refused a body of neither, or of both, of the two. */
const splitOf = (body: SplitBody): TemplateSplit =>
  'splitBetween' in body
    ? { kind: 'equal', members: body.splitBetween }
    : { kind: 'shares', shares: body.splitByShares };

export class FastifyTemplateController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async saveTemplate(req: FastifyRequest<{ Params: { id: string }; Body: TemplateBody }>, reply: FastifyReply) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      SaveTemplateCommandEvent.set({ groupId: req.params.id, name: req.body.name, split: splitOf(req.body) }),
    );
  }

  async replaceTemplate(req: FastifyRequest<{ Params: { id: string }; Body: TemplateBody }>, reply: FastifyReply) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      ReplaceTemplateCommandEvent.set({ templateId: req.params.id, name: req.body.name, split: splitOf(req.body) }),
    );
  }

  async removeTemplate(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, RemoveTemplateCommandEvent.set({ templateId: req.params.id }));
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

    return { message: error.message };
  }
}
