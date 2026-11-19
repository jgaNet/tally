import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { GetMyInsightsQueryHandler } from '@Contexts/Ledger/Application/Queries/GetMyInsights/GetMyInsightsQueryHandler';
import { refuse } from '@Contexts/Ledger/Presentation/API/REST/Controllers/refuse';

export class FastifyInsightController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getMyInsights(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetMyInsightsQueryHandler).handle(undefined, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }
}
