import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { acceptCommand } from '@Architecture/Presentation/AcceptCommand';
import { SetUpRecurringExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/SetUpRecurringExpense';
import { StopRecurringExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/StopRecurringExpense';
import {
  GetGroupRecurringExpensesQueryHandler,
  GetRecurringExpenseQueryHandler,
} from '@Contexts/Ledger/Application/Queries';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { refuse } from '@Contexts/Ledger/Presentation/API/REST/Controllers/refuse';

export class FastifyRecurringController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  setUpRecurringExpense(
    req: FastifyRequest<{
      Params: { id: string };
      Body: { description: string; amount: number; startsOn: string } & SplitRequest;
    }>,
    reply: FastifyReply,
  ) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      SetUpRecurringExpenseCommandEvent.set({ groupId: req.params.id, ...req.body }),
    );
  }

  stopRecurringExpense(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(
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
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }

  async getGroupRecurringExpenses(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupRecurringExpensesQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }
}
