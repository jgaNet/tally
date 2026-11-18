import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { acceptCommand } from '@Architecture/Presentation/AcceptCommand';
import { RemoveBudgetCommandEvent } from '@Contexts/Ledger/Application/Commands/RemoveBudget/RemoveBudgetCommandEvent';
import { SetBudgetCommandEvent } from '@Contexts/Ledger/Application/Commands/SetBudget/SetBudgetCommandEvent';
import { GetGroupBudgetsQueryHandler } from '@Contexts/Ledger/Application/Queries/GetGroupBudgets/GetGroupBudgetsQueryHandler';
import { refuse } from '@Contexts/Ledger/Presentation/API/REST/Controllers/refuse';

export class FastifyBudgetController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  setBudget(
    req: FastifyRequest<{ Params: { id: string; category: string }; Body: { amount: number } }>,
    reply: FastifyReply,
  ) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      SetBudgetCommandEvent.set({ groupId: req.params.id, category: req.params.category, amount: req.body.amount }),
    );
  }

  removeBudget(req: FastifyRequest<{ Params: { id: string; category: string } }>, reply: FastifyReply) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      RemoveBudgetCommandEvent.set({ groupId: req.params.id, category: req.params.category }),
    );
  }

  async getGroupBudgets(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupBudgetsQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }
}
