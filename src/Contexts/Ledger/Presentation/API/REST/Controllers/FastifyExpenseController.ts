import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommand, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { DeleteExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/DeleteExpense';
import { EditExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/EditExpense';
import { RecordExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/RecordExpense';
import { GetExpenseQueryHandler } from '@Contexts/Ledger/Application/Queries';
import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';

/** Exactly one of the three ways to split, as a body gives it (request 7). */
type SplitBody =
  | { splitBetween: string[] }
  | { splitExactly: { memberId: string; amount: number }[] }
  | { splitByShares: { memberId: string; shares: number }[] };
type RecordExpenseBody = { description: string; amount: number; date: string } & SplitBody;
type EditExpenseBody = RecordExpenseBody & { version: number };

/** The split a body gives, by its kind: the transport has refused a body of none, or of more than one, of the three. */
const splitOf = (body: SplitBody): SplitInput => {
  if ('splitBetween' in body) return { kind: 'equal', members: body.splitBetween };
  if ('splitExactly' in body) return { kind: 'exact', amounts: body.splitExactly };
  return { kind: 'shares', shares: body.splitByShares };
};

export class FastifyExpenseController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async recordExpense(req: FastifyRequest<{ Params: { id: string }; Body: RecordExpenseBody }>, reply: FastifyReply) {
    const { description, amount, date } = req.body;
    return acceptCommand(
      req,
      reply,
      this.#module,
      RecordExpenseCommandEvent.set({ groupId: req.params.id, description, amount, date, split: splitOf(req.body) }),
    );
  }

  async editExpense(req: FastifyRequest<{ Params: { id: string }; Body: EditExpenseBody }>, reply: FastifyReply) {
    const { description, amount, date, version } = req.body;
    return acceptCommand(
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

  async deleteExpense(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, DeleteExpenseCommandEvent.set({ expenseId: req.params.id }));
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

    return { message: error.message };
  }
}
