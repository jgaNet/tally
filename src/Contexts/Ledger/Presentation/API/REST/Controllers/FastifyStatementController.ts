import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { GetMemberStatementQueryHandler } from '@Contexts/Ledger/Application/Queries';
import { refuse } from '@Contexts/Ledger/Presentation/API/REST/Controllers/refuse';

export class FastifyStatementController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getMemberStatement(req: FastifyRequest<{ Params: { id: string; memberId: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetMemberStatementQueryHandler)
      .handle({ groupId: req.params.id, memberId: req.params.memberId }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }
}
