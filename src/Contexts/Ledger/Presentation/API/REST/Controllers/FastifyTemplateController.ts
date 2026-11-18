import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { acceptCommand } from '@Architecture/Presentation/AcceptCommand';
import { SaveTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/SaveTemplate/SaveTemplateCommandEvent';
import { ReplaceTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/ReplaceTemplate/ReplaceTemplateCommandEvent';
import { RemoveTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/RemoveTemplate/RemoveTemplateCommandEvent';
import { GetGroupTemplatesQueryHandler } from '@Contexts/Ledger/Application/Queries/GetGroupTemplates/GetGroupTemplatesQueryHandler';
import { refuse } from '@Contexts/Ledger/Presentation/API/REST/Controllers/refuse';

type TemplateBody = { name: string; splitBetween?: string[]; splitByShares?: { memberId: string; shares: number }[] };

export class FastifyTemplateController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  saveTemplate(req: FastifyRequest<{ Params: { id: string }; Body: TemplateBody }>, reply: FastifyReply) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      SaveTemplateCommandEvent.set({ groupId: req.params.id, ...req.body }),
    );
  }

  replaceTemplate(req: FastifyRequest<{ Params: { id: string }; Body: TemplateBody }>, reply: FastifyReply) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      ReplaceTemplateCommandEvent.set({ templateId: req.params.id, ...req.body }),
    );
  }

  removeTemplate(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, RemoveTemplateCommandEvent.set({ templateId: req.params.id }));
  }

  async getGroupTemplates(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupTemplatesQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }
}
