import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommandAtOnce, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import {
  DeleteExpenseCommandEvent,
  EditExpenseCommandEvent,
  RecordExpenseCommandEvent,
} from '@Contexts/Ledger/Application/Commands';
import { GetExpenseQueryHandler, GetGroupExpensesQueryHandler } from '@Contexts/Ledger/Application/Queries';
import { ExpenseMoney } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';
import {
  AmountBody,
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
    const { description, date } = req.body;
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      RecordExpenseCommandEvent.set({
        groupId: req.params.id,
        description,
        money: moneyOf(req.body),
        date,
        split: req.body.template === undefined ? splitOf(req.body) : undefined,
        template: req.body.template,
        category: req.body.category,
      }),
    );
  }

  editExpense(req: FastifyRequest<{ Params: { id: string }; Body: EditExpenseBody }>, reply: FastifyReply) {
    const { description, date, version } = req.body;
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      EditExpenseCommandEvent.set({
        expenseId: req.params.id,
        description,
        money: moneyOf(req.body),
        date,
        version,
        split: req.body.template === undefined ? splitOf(req.body) : undefined,
        template: req.body.template,
        category: req.body.category,
      }),
    );
  }

  deleteExpense(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommandAtOnce(req, reply, this.#module, DeleteExpenseCommandEvent.set({ expenseId: req.params.id }));
  }

  async getGroupExpenses(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupExpensesQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
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
 * The amount the body gives: what was paid in another currency when the body has `original`, the amount in the group's
 * currency otherwise. The transport has let exactly one of the two through, so the one given is the money; the values
 * of either are the domain's to refuse (request 21).
 */
const moneyOf = (body: AmountBody): ExpenseMoney =>
  body.original ? { original: body.original } : { amount: body.amount ?? 0 };

/**
 * The split the body gives. The transport has let exactly one of the three through (the schema answers 400 to any other
 * body), so the one given is the split; an equal split is the default only for a body the schema has not seen.
 */
export const splitOf = (body: SplitBody): SplitRequest => {
  if (body.splitExactly) return { kind: 'exact', amounts: body.splitExactly };
  if (body.splitByShares) return { kind: 'shares', shares: body.splitByShares };
  return { kind: 'equal', memberIds: body.splitBetween ?? [] };
};
