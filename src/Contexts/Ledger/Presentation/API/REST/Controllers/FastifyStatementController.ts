import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import {
  GetMemberStatementQueryHandler,
  GetMemberStatementCsvQueryHandler,
} from '@Contexts/Ledger/Application/Queries';
import { statementCsv } from '@Contexts/Ledger/Presentation/API/REST/Controllers/StatementCsv';

/** The route of statements: a member reads the statement of any member of their group, themselves included, as JSON or as CSV. */
export class FastifyStatementController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getMemberStatement(req: FastifyRequest<{ Params: { id: string; memberId: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetMemberStatementQueryHandler)
      .handle({ groupId: req.params.id, memberId: req.params.memberId }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  async getMemberStatementCsv(req: FastifyRequest<{ Params: { id: string; memberId: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetMemberStatementCsvQueryHandler)
      .handle({ groupId: req.params.id, memberId: req.params.memberId }, req.executionContext);
    if (result.isFailure()) return this.refuse(reply, result.error, req.executionContext);

    reply.type('text/csv');
    return statementCsv(result.data);
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { type: error.type, message: error.message };
  }
}
