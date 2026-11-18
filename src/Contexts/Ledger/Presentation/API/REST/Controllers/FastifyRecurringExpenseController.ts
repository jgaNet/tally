import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommand, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { SetUpRecurringExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/SetUpRecurringExpense';
import { StopRecurringExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/StopRecurringExpense';
import {
  GetGroupRecurringExpensesQueryHandler,
  GetRecurringExpenseQueryHandler,
} from '@Contexts/Ledger/Application/Queries';
import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';

/** Exactly one of the three ways to split, as a body gives it (request 7, request 23). */
type SplitBody =
  | { splitBetween: string[] }
  | { splitExactly: { memberId: string; amount: number }[] }
  | { splitByShares: { memberId: string; shares: number }[] };
type SetUpRecurringBody = { description: string; amount: number; startsOn: string; category?: string } & SplitBody;

/** The split a body gives, by its kind: the transport has refused a body of none, or of more than one, of the three. */
const splitOf = (body: SplitBody): SplitInput => {
  if ('splitBetween' in body) return { kind: 'equal', members: body.splitBetween };
  if ('splitExactly' in body) return { kind: 'exact', amounts: body.splitExactly };
  return { kind: 'shares', shares: body.splitByShares };
};

export class FastifyRecurringExpenseController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async setUp(req: FastifyRequest<{ Params: { id: string }; Body: SetUpRecurringBody }>, reply: FastifyReply) {
    const { description, amount, startsOn, category } = req.body;
    return acceptCommand(
      req,
      reply,
      this.#module,
      SetUpRecurringExpenseCommandEvent.set({
        groupId: req.params.id,
        description,
        amount,
        startsOn,
        split: splitOf(req.body),
        category,
      }),
    );
  }

  async stop(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      StopRecurringExpenseCommandEvent.set({ recurringExpenseId: req.params.id }),
    );
  }

  async getRecurring(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetRecurringExpenseQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  async getGroupRecurring(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupRecurringExpensesQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { message: error.message };
  }
}
