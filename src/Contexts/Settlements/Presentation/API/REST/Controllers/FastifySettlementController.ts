import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommand, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { PayThroughProviderCommandEvent } from '@Contexts/Settlements/Application/Commands/PayThroughProvider';
import { ReceivePaymentWebhookCommandEvent } from '@Contexts/Settlements/Application/Commands/ReceivePaymentWebhook';
import { NetDebtsCommandEvent } from '@Contexts/Settlements/Application/Commands/NetDebts';
import { RecordCashSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/RecordCashSettlement';
import { MoneyPayload } from '@Contexts/Settlements/Application/Commands/PaidIn';
import { RefundSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/RefundSettlement';
import { ContestSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/ContestSettlement';
import { DecideContestCommandEvent } from '@Contexts/Settlements/Application/Commands/DecideContest';
import { SetFeePolicyCommandEvent } from '@Contexts/Settlements/Application/Commands/SetFeePolicy';
import {
  GetContestsQueryHandler,
  GetFeePolicyQueryHandler,
  GetGroupSettlementsQueryHandler,
  GetNettingQueryHandler,
  GetSettlementQueryHandler,
  GetSuggestedSettlementsQueryHandler,
} from '@Contexts/Settlements/Application/Queries';

/** The money a body gives: an amount in the group's currency, or what is paid in another currency (request 39). The transport has refused neither, nor both. */
type MoneyBody = { amount: number } | { original: { currency: string; amount: number } };

const moneyOf = (body: MoneyBody): MoneyPayload =>
  'original' in body ? { original: body.original } : { amount: body.amount };

export class FastifySettlementController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async getSuggested(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetSuggestedSettlementsQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  async recordCash(
    req: FastifyRequest<{ Params: { id: string }; Body: { from: string } & MoneyBody }>,
    reply: FastifyReply,
  ) {
    const { from } = req.body;
    return acceptCommand(
      req,
      reply,
      this.#module,
      RecordCashSettlementCommandEvent.set({ groupId: req.params.id, from, money: moneyOf(req.body) }),
    );
  }

  async payThroughProvider(
    req: FastifyRequest<{ Params: { id: string }; Body: { to: string } & MoneyBody }>,
    reply: FastifyReply,
  ) {
    const { to } = req.body;
    return acceptCommand(
      req,
      reply,
      this.#module,
      PayThroughProviderCommandEvent.set({ groupId: req.params.id, to, money: moneyOf(req.body) }),
    );
  }

  async refundSettlement(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, RefundSettlementCommandEvent.set({ settlementId: req.params.id }));
  }

  async netDebts(req: FastifyRequest<{ Body: { with: string; currency: string } }>, reply: FastifyReply) {
    const { with: withAccount, currency } = req.body;
    return acceptCommand(req, reply, this.#module, NetDebtsCommandEvent.set({ with: withAccount, currency }));
  }

  async getNetting(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetNettingQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  async receivePaymentWebhook(req: FastifyRequest, reply: FastifyReply) {
    const { id, paymentId, status, at } = req.body as { id: string; paymentId: string; status: string; at: string };
    return acceptCommand(
      req,
      reply,
      this.#module,
      ReceivePaymentWebhookCommandEvent.set({ webhookId: id, paymentId, status, at }),
    );
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

  async contest(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, ContestSettlementCommandEvent.set({ settlementId: req.params.id }));
  }

  async decideContest(req: FastifyRequest<{ Params: { id: string }; Body: { paid: boolean } }>, reply: FastifyReply) {
    const { paid } = req.body;
    return acceptCommand(
      req,
      reply,
      this.#module,
      DecideContestCommandEvent.set({ settlementId: req.params.id, paid }),
    );
  }

  async getContests(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetContestsQueryHandler).handle(undefined, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  async getFeePolicy(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetFeePolicyQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  async setFeePolicy(req: FastifyRequest<{ Params: { id: string }; Body: { borneBy: string } }>, reply: FastifyReply) {
    const { borneBy } = req.body;
    return acceptCommand(req, reply, this.#module, SetFeePolicyCommandEvent.set({ groupId: req.params.id, borneBy }));
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { message: error.message };
  }
}
