import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommandAtOnce, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { RecordExpenseCommandEvent, RecordExpensePayload } from '@Contexts/Ledger/Application/Commands';
import { GetExpenseQueryHandler } from '@Contexts/Ledger/Application/Queries';

/** The routes of expenses: a member records one of their group, and reads one of theirs. */
export class FastifyExpenseController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  recordExpense(
    req: FastifyRequest<{ Params: { id: string }; Body: Omit<RecordExpensePayload, 'groupId'> }>,
    reply: FastifyReply,
  ) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      RecordExpenseCommandEvent.set({ ...req.body, groupId: req.params.id }),
    );
  }

  async getExpense(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetExpenseQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { type: error.type, message: error.message };
  }
}
