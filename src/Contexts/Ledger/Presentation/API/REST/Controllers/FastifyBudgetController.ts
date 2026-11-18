import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommand, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { RemoveBudgetCommandEvent } from '@Contexts/Ledger/Application/Commands/RemoveBudget';
import { SetBudgetCommandEvent } from '@Contexts/Ledger/Application/Commands/SetBudget';
import { GetGroupBudgetsQueryHandler } from '@Contexts/Ledger/Application/Queries';

export class FastifyBudgetController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async setBudget(
    req: FastifyRequest<{ Params: { id: string; category: string }; Body: { amount: number } }>,
    reply: FastifyReply,
  ) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      SetBudgetCommandEvent.set({
        groupId: req.params.id,
        category: req.params.category,
        amount: req.body.amount,
      }),
    );
  }

  async removeBudget(req: FastifyRequest<{ Params: { id: string; category: string } }>, reply: FastifyReply) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      RemoveBudgetCommandEvent.set({ groupId: req.params.id, category: req.params.category }),
    );
  }

  async getBudgets(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupBudgetsQueryHandler)
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
