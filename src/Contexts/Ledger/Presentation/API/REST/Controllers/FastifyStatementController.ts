import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import {
  GetMemberStatementCsvQueryHandler,
  GetMemberStatementQueryHandler,
} from '@Contexts/Ledger/Application/Queries';
import { refuse } from '@Contexts/Ledger/Presentation/API/REST/Controllers/refuse';
import { statementAsCsv } from '@Contexts/Ledger/Presentation/API/REST/Controllers/statementAsCsv';

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

  /** The same statement as the JSON route, rendered as CSV by the transport (request 29). */
  async getMemberStatementCsv(req: FastifyRequest<{ Params: { id: string; memberId: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetMemberStatementCsvQueryHandler)
      .handle({ groupId: req.params.id, memberId: req.params.memberId }, req.executionContext);
    if (result.isFailure()) return refuse(reply, result.error);
    return reply.type('text/csv; charset=utf-8').send(statementAsCsv(result.data));
  }
}
