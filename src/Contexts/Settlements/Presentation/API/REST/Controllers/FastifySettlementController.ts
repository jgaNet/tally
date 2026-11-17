import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommandAtOnce, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { RecordCashSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands';
import {
  GetSettlementQueryHandler,
  GetSuggestedSettlementsQueryHandler,
} from '@Contexts/Settlements/Application/Queries';
import { RecordCashSettlementBody } from '@Contexts/Settlements/Presentation/API/REST/Routes/settlement.routes.schema';

/** The routes of settlements: a member reads the suggested transfers of their group (request 11), records a cash settlement and reads one (request 12). */
export class FastifySettlementController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getSuggestedSettlements(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetSuggestedSettlementsQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  recordCashSettlement(
    req: FastifyRequest<{ Params: { id: string }; Body: RecordCashSettlementBody }>,
    reply: FastifyReply,
  ) {
    const { from, amount } = req.body;
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      RecordCashSettlementCommandEvent.set({ groupId: req.params.id, from, amount }),
    );
  }

  async getSettlement(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetSettlementQueryHandler)
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
