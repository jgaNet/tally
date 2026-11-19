import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { acceptCommand } from '@Architecture/Presentation/AcceptCommand';
import {
  ContestSettlementCommandEvent,
  DecideContestCommandEvent,
  NetDebtsCommandEvent,
  PayThroughProviderCommandEvent,
  ReceivePaymentWebhookCommandEvent,
  RecordCashSettlementCommandEvent,
  RefundSettlementCommandEvent,
  SetFeePolicyCommandEvent,
  SetPayoutAccountCommandEvent,
} from '@Contexts/Settlements/Application/Commands';
import {
  GetContestsQueryHandler,
  GetFeePolicyQueryHandler,
  GetGroupSettlementsQueryHandler,
  GetNettingQueryHandler,
  GetPayoutAccountQueryHandler,
  GetSettlementQueryHandler,
  GetSuggestedSettlementsQueryHandler,
} from '@Contexts/Settlements/Application/Queries';
import { refuse } from '@Contexts/Settlements/Presentation/API/REST/Controllers/refuse';
import { signatureMatches } from '@Contexts/Settlements/Presentation/API/REST/Controllers/ProviderSignature';

/** A payment's body: either the amount in the group's currency, or what is paid in another one (request 39); the transport checks one of them. */
type PaymentBody = { amount?: number; original?: { currency: string; amount: number } };

/** The amount a payment's body gives: `original` when it is paid in another currency, otherwise `amount` (request 39). */
function amountOf(body: PaymentBody): PaymentBody {
  return body.original !== undefined ? { original: body.original } : { amount: body.amount };
}

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
    req: FastifyRequest<{ Params: { id: string }; Body: PaymentBody & { from: string } }>,
    reply: FastifyReply,
  ) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      RecordCashSettlementCommandEvent.set({ groupId: req.params.id, from: req.body.from, ...amountOf(req.body) }),
    );
  }

  payThroughProvider(
    req: FastifyRequest<{ Params: { id: string }; Body: PaymentBody & { to: string } }>,
    reply: FastifyReply,
  ) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      PayThroughProviderCommandEvent.set({ groupId: req.params.id, to: req.body.to, ...amountOf(req.body) }),
    );
  }

  /** A member nets what they and another member owe each other across their groups, in one currency: answered at once, its outcome read later (request 32). */
  netDebts(req: FastifyRequest<{ Body: { with: string; currency: string } }>, reply: FastifyReply) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      NetDebtsCommandEvent.set({ with: req.body.with, currency: req.body.currency }),
    );
  }

  /** One of the two people reads a netting: 404 for anyone else (request 32). */
  async getNetting(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetNettingQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }

  /** The payee asks the provider to refund a settlement paid through it: answered at once, its outcome read later (request 15). */
  refundSettlement(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, RefundSettlementCommandEvent.set({ settlementId: req.params.id }));
  }

  /** The payee says the money of a settlement paid through the provider did not reach them: answered at once, its outcome read later (request 33). */
  contestSettlement(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, ContestSettlementCommandEvent.set({ settlementId: req.params.id }));
  }

  /** An administrator decides a contested settlement: answered at once, its outcome read later (request 33). */
  decideContest(req: FastifyRequest<{ Params: { id: string }; Body: { paid: boolean } }>, reply: FastifyReply) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      DecideContestCommandEvent.set({ settlementId: req.params.id, paid: req.body.paid }),
    );
  }

  /** An administrator lists the settlements contested now, the earliest contested first: 401 to a caller not signed in, 404 to anyone else (request 33). */
  async getContests(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetContestsQueryHandler).handle(undefined, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error, req.executionContext) : result.data;
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

  /** A member of the group sets who bears the provider's fee: answered at once, its outcome read later (request 38). */
  setFeePolicy(req: FastifyRequest<{ Params: { id: string }; Body: { borneBy: string } }>, reply: FastifyReply) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      SetFeePolicyCommandEvent.set({ groupId: req.params.id, borneBy: req.body.borneBy }),
    );
  }

  /** A member of the group reads who bears the provider's fee: 404 for anyone else (request 38). */
  async getFeePolicy(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetFeePolicyQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }

  async getSettlement(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetSettlementQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }
}
