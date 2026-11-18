import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { GetGroupAuditQueryHandler } from '@Contexts/Ledger/Application/Queries/GetGroupAudit/GetGroupAuditQueryHandler';
import { refuse } from '@Contexts/Ledger/Presentation/API/REST/Controllers/refuse';

export class FastifyAuditController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getGroupAudit(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupAuditQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }
}
