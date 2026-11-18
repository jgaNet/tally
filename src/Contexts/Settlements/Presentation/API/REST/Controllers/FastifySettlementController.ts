import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommandAtOnce, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import {
  ContestSettlementCommandEvent,
  DecideContestCommandEvent,
  SetFeePolicyCommandEvent,
  NetDebtsCommandEvent,
  PayThroughProviderCommandEvent,
  RecordCashSettlementCommandEvent,
  RefundSettlementCommandEvent,
  SetPayoutAccountCommandEvent,
} from '@Contexts/Settlements/Application/Commands';
import { ReceivePaymentWebhookCommandEvent } from '@Contexts/Settlements/Application/Commands/ReceivePaymentWebhook/ReceivePaymentWebhookCommandEvent';
import {
  GetContestsQueryHandler,
  GetFeePolicyQueryHandler,
  GetGroupSettlementsQueryHandler,
  GetNettingQueryHandler,
  GetPayoutAccountQueryHandler,
  GetSettlementQueryHandler,
  GetSuggestedSettlementsQueryHandler,
} from '@Contexts/Settlements/Application/Queries';
import {
  DecideContestBody,
  NetDebtsBody,
  PayThroughProviderBody,
  ProviderWebhookBody,
  RecordCashSettlementBody,
  SetFeePolicyBody,
  SetPayoutAccountBody,
} from '@Contexts/Settlements/Presentation/API/REST/Routes/settlement.routes.schema';

/** The routes of settlements: a member reads the suggested transfers of their group (request 11), records a cash settlement and reads one (request 12), pays through the provider and takes its webhook (request 13), and refunds a payment through the provider (request 15). */
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
    const { from, amount, original } = req.body;
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      RecordCashSettlementCommandEvent.set({
        groupId: req.params.id,
        from,
        amount: amount ?? null,
        original: original ?? null,
      }),
    );
  }

  payThroughProvider(
    req: FastifyRequest<{ Params: { id: string }; Body: PayThroughProviderBody }>,
    reply: FastifyReply,
  ) {
    const { to, amount, original } = req.body;
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      PayThroughProviderCommandEvent.set({
        groupId: req.params.id,
        to,
        amount: amount ?? null,
        original: original ?? null,
      }),
    );
  }

  refundSettlement(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      RefundSettlementCommandEvent.set({ settlementId: req.params.id }),
    );
  }

  contestSettlement(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      ContestSettlementCommandEvent.set({ settlementId: req.params.id }),
    );
  }

  decideContest(req: FastifyRequest<{ Params: { id: string }; Body: DecideContestBody }>, reply: FastifyReply) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      DecideContestCommandEvent.set({ settlementId: req.params.id, paid: req.body.paid }),
    );
  }

  async getContests(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetContestsQueryHandler).handle(undefined, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  receiveProviderWebhook(req: FastifyRequest<{ Body: ProviderWebhookBody }>, reply: FastifyReply) {
    const { paymentId, status } = req.body;
    return acceptCommandAtOnce(req, reply, this.#module, ReceivePaymentWebhookCommandEvent.set({ paymentId, status }));
  }

  async getGroupSettlements(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupSettlementsQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  async getSettlement(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetSettlementQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  /** A netting of what the caller and another person owe each other across their groups, asked at once (request 32). */
  netDebts(req: FastifyRequest<{ Body: NetDebtsBody }>, reply: FastifyReply) {
    const { with: other, currency } = req.body;
    return acceptCommandAtOnce(req, reply, this.#module, NetDebtsCommandEvent.set({ with: other, currency }));
  }

  async getNetting(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetNettingQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  /** The owner of the group decides who bears its provider's fee, asked at once (request 38). */
  setFeePolicy(req: FastifyRequest<{ Params: { id: string }; Body: SetFeePolicyBody }>, reply: FastifyReply) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      SetFeePolicyCommandEvent.set({ groupId: req.params.id, borneBy: req.body.borneBy }),
    );
  }

  async getFeePolicy(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetFeePolicyQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  setPayoutAccount(req: FastifyRequest<{ Body: SetPayoutAccountBody }>, reply: FastifyReply) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      SetPayoutAccountCommandEvent.set({ accountId: req.body.accountId }),
    );
  }

  async getPayoutAccount(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetPayoutAccountQueryHandler).handle(undefined, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { type: error.type, message: error.message };
  }
}
