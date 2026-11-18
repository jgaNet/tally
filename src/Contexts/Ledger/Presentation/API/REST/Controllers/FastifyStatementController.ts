import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import {
  GetMemberStatementCsvQueryHandler,
  GetMemberStatementQueryHandler,
} from '@Contexts/Ledger/Application/Queries';
import { renderStatementCsv } from '@Contexts/Ledger/Presentation/API/REST/Controllers/StatementCsv';

export class FastifyStatementController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getStatement(req: FastifyRequest<{ Params: { id: string; memberId: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetMemberStatementQueryHandler)
      .handle({ groupId: req.params.id, memberId: req.params.memberId }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  /** The same statement as text/csv, in UTF-8 (request 29); a refusal is the JSON one of the statement. */
  async getStatementCsv(req: FastifyRequest<{ Params: { id: string; memberId: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetMemberStatementCsvQueryHandler)
      .handle({ groupId: req.params.id, memberId: req.params.memberId }, req.executionContext);
    if (result.isFailure()) return this.refuse(reply, result.error, req.executionContext);

    reply.type('text/csv; charset=utf-8');
    return renderStatementCsv(result.data);
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { message: error.message };
  }
}
