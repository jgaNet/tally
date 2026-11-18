import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommandAtOnce, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { SetUpRecurringExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/SetUpRecurringExpense/SetUpRecurringExpenseCommandEvent';
import { StopRecurringExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/StopRecurringExpense/StopRecurringExpenseCommandEvent';
import { GetGroupRecurringExpensesQueryHandler } from '@Contexts/Ledger/Application/Queries/GetGroupRecurringExpenses/GetGroupRecurringExpensesQueryHandler';
import { GetRecurringExpenseQueryHandler } from '@Contexts/Ledger/Application/Queries/GetRecurringExpense/GetRecurringExpenseQueryHandler';
import { splitOf } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyExpenseController';
import { SetUpRecurringBody } from '@Contexts/Ledger/Presentation/API/REST/Routes/recurring.routes.schema';

/** The routes of recurring expenses: a member sets one up in their group, its payer, and reads or stops those of theirs (request 23). */
export class FastifyRecurringExpenseController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  setUpRecurringExpense(
    req: FastifyRequest<{ Params: { id: string }; Body: SetUpRecurringBody }>,
    reply: FastifyReply,
  ) {
    const { description, amount, startsOn } = req.body;
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      SetUpRecurringExpenseCommandEvent.set({
        groupId: req.params.id,
        description,
        amount,
        startsOn,
        split: splitOf(req.body),
        category: req.body.category,
      }),
    );
  }

  stopRecurringExpense(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      StopRecurringExpenseCommandEvent.set({ recurringId: req.params.id }),
    );
  }

  async getRecurringExpense(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetRecurringExpenseQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  async getGroupRecurringExpenses(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupRecurringExpensesQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { type: error.type, message: error.message };
  }
}
