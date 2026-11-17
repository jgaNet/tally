import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommandAtOnce, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import {
  DeleteExpenseCommandEvent,
  EditExpenseCommandEvent,
  RecordExpenseCommandEvent,
} from '@Contexts/Ledger/Application/Commands';
import { GetExpenseQueryHandler } from '@Contexts/Ledger/Application/Queries';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';
import {
  CreateExpenseBody,
  EditExpenseBody,
  SplitBody,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

/** The routes of expenses: a member records one of their group, and reads one of theirs. */
export class FastifyExpenseController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  recordExpense(req: FastifyRequest<{ Params: { id: string }; Body: CreateExpenseBody }>, reply: FastifyReply) {
    const { description, amount, date } = req.body;
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      RecordExpenseCommandEvent.set({
        groupId: req.params.id,
        description,
        amount,
        date,
        split: splitOf(req.body),
      }),
    );
  }

  editExpense(req: FastifyRequest<{ Params: { id: string }; Body: EditExpenseBody }>, reply: FastifyReply) {
    const { description, amount, date, version } = req.body;
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      EditExpenseCommandEvent.set({
        expenseId: req.params.id,
        description,
        amount,
        date,
        version,
        split: splitOf(req.body),
      }),
    );
  }

  deleteExpense(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommandAtOnce(req, reply, this.#module, DeleteExpenseCommandEvent.set({ expenseId: req.params.id }));
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

/**
 * The split the body gives. The transport has let exactly one of the three through (the schema answers 400 to any other
 * body), so the one given is the split; an equal split is the default only for a body the schema has not seen.
 */
const splitOf = (body: SplitBody): SplitRequest => {
  if (body.splitExactly) return { kind: 'exact', amounts: body.splitExactly };
  if (body.splitByShares) return { kind: 'shares', shares: body.splitByShares };
  return { kind: 'equal', memberIds: body.splitBetween ?? [] };
};
