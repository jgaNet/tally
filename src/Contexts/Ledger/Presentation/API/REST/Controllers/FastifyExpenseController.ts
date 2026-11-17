import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommand, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { DeleteExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/DeleteExpense';
import { EditExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/EditExpense';
import { RecordExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/RecordExpense';
import { GetExpenseQueryHandler } from '@Contexts/Ledger/Application/Queries';

type RecordExpenseBody = { description: string; amount: number; date: string; splitBetween: string[] };
type EditExpenseBody = RecordExpenseBody & { version: number };

export class FastifyExpenseController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async recordExpense(req: FastifyRequest<{ Params: { id: string }; Body: RecordExpenseBody }>, reply: FastifyReply) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      RecordExpenseCommandEvent.set({ groupId: req.params.id, ...req.body }),
    );
  }

  async editExpense(req: FastifyRequest<{ Params: { id: string }; Body: EditExpenseBody }>, reply: FastifyReply) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      EditExpenseCommandEvent.set({ expenseId: req.params.id, ...req.body }),
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
