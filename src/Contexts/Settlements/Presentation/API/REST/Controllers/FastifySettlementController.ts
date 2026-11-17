import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { acceptCommand } from '@Architecture/Presentation/AcceptCommand';
import {
  PayThroughProviderCommandEvent,
  ReceivePaymentWebhookCommandEvent,
  RecordCashSettlementCommandEvent,
  RefundSettlementCommandEvent,
  SetPayoutAccountCommandEvent,
} from '@Contexts/Settlements/Application/Commands';
import {
  GetGroupSettlementsQueryHandler,
  GetPayoutAccountQueryHandler,
  GetSettlementQueryHandler,
  GetSuggestedSettlementsQueryHandler,
} from '@Contexts/Settlements/Application/Queries';
import { refuse } from '@Contexts/Settlements/Presentation/API/REST/Controllers/refuse';
import { signatureMatches } from '@Contexts/Settlements/Presentation/API/REST/Controllers/ProviderSignature';

/** A webhook's body as it was sent, kept beside the parsed one, for its signature (ADR 8). */
export type WebhookRequest = FastifyRequest & { rawBody?: string };

export class FastifySettlementController {
  readonly #module: Module;
  readonly #providerWebhookSecret: string;

  constructor({ module, providerWebhookSecret = '' }: { module: Module; providerWebhookSecret?: string }) {
    this.#module = module;
    this.#providerWebhookSecret = providerWebhookSecret;
  }

  async getSuggestedSettlements(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetSuggestedSettlementsQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }

  recordCashSettlement(
    req: FastifyRequest<{ Params: { id: string }; Body: { from: string; amount: number } }>,
    reply: FastifyReply,
  ) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      RecordCashSettlementCommandEvent.set({ groupId: req.params.id, from: req.body.from, amount: req.body.amount }),
    );
  }

  payThroughProvider(
    req: FastifyRequest<{ Params: { id: string }; Body: { to: string; amount: number } }>,
    reply: FastifyReply,
  ) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      PayThroughProviderCommandEvent.set({ groupId: req.params.id, to: req.body.to, amount: req.body.amount }),
    );
  }

  /** The payee asks the provider to refund a settlement paid through it: answered at once, its outcome read later (request 15). */
  refundSettlement(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, RefundSettlementCommandEvent.set({ settlementId: req.params.id }));
  }

  /** The provider's webhook: refused with 401 and nothing changed unless it is signed; otherwise acknowledged at once. */
  receivePaymentWebhook(req: WebhookRequest, reply: FastifyReply) {
    const signature = req.headers['provider-signature'];
    if (
      !signatureMatches(
        this.#providerWebhookSecret,
        req.rawBody ?? '',
        typeof signature === 'string' ? signature : undefined,
      )
    ) {
      reply.code(401);
      return { message: 'The webhook is not signed by the provider' };
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    return acceptCommand(
      req,
      reply,
      this.#module,
      ReceivePaymentWebhookCommandEvent.set({
        id: String(body.id ?? ''),
        paymentId: String(body.paymentId ?? ''),
        status: String(body.status ?? ''),
        at: String(body.at ?? ''),
      }),
    );
  }

  /** A signed-in person sets the payout account the provider pays them on: answered at once, its outcome read later (request 16). */
  setPayoutAccount(req: FastifyRequest<{ Body: { accountId: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, SetPayoutAccountCommandEvent.set({ accountId: req.body.accountId }));
  }

  /** A signed-in person reads their own payout account: 404 when they have set none (request 16). */
  async getPayoutAccount(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetPayoutAccountQueryHandler).handle(undefined, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }

  /** A member of the group lists its settlements, the most recent first, each with its history (request 19). */
  async getGroupSettlements(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupSettlementsQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }

  async getSettlement(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetSettlementQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }
}
