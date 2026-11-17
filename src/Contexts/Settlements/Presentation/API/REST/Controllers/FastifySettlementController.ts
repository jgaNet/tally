import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { GetSuggestedSettlementsQueryHandler } from '@Contexts/Settlements/Application/Queries';
import { refuse } from '@Contexts/Settlements/Presentation/API/REST/Controllers/refuse';

export class FastifySettlementController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getSuggestedSettlements(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetSuggestedSettlementsQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }
}
