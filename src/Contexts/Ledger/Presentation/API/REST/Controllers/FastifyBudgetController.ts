import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommandAtOnce, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { RemoveBudgetCommandEvent } from '@Contexts/Ledger/Application/Commands/RemoveBudget/RemoveBudgetCommandEvent';
import { SetBudgetCommandEvent } from '@Contexts/Ledger/Application/Commands/SetBudget/SetBudgetCommandEvent';
import { GetGroupBudgetsQueryHandler } from '@Contexts/Ledger/Application/Queries/GetGroupBudgets/GetGroupBudgetsQueryHandler';
import { asCategory, SetBudgetBody } from '@Contexts/Ledger/Presentation/API/REST/Routes/budget.routes.schema';

/** The routes of budgets: the owner of a group sets or removes a category's budget, and a member reads the group's (request 24). */
export class FastifyBudgetController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  setBudget(
    req: FastifyRequest<{ Params: { id: string; category: string }; Body: SetBudgetBody }>,
    reply: FastifyReply,
  ) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      SetBudgetCommandEvent.set({
        groupId: req.params.id,
        category: asCategory(req.params.category),
        amount: req.body.amount,
      }),
    );
  }

  removeBudget(req: FastifyRequest<{ Params: { id: string; category: string } }>, reply: FastifyReply) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      RemoveBudgetCommandEvent.set({
        groupId: req.params.id,
        category: asCategory(req.params.category),
      }),
    );
  }

  async getGroupBudgets(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupBudgetsQueryHandler)
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
