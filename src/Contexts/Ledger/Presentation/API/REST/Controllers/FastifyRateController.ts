import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { GetOfferedRateQueryHandler } from '@Contexts/Ledger/Application/Queries';
import { refuse } from '@Contexts/Ledger/Presentation/API/REST/Controllers/refuse';

export class FastifyRateController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getOfferedRate(
    req: FastifyRequest<{ Params: { id: string; currency: string }; Querystring: { date?: string } }>,
    reply: FastifyReply,
  ) {
    const result = await this.#module
      .getQuery(GetOfferedRateQueryHandler)
      .handle({ groupId: req.params.id, currency: req.params.currency, date: req.query.date }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }
}
