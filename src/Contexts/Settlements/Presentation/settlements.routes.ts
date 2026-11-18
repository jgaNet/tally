import { FastifyPluginCallback, FastifyRequest } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import {
  getFeePolicy,
  getGroupSettlements,
  getSettlement,
  payThroughProvider,
  receivePaymentWebhook,
  recordCashSettlement,
  refundSettlement,
  setFeePolicy,
} from '@Contexts/Settlements/Application/Settlements';
import { getPayoutAccount, setPayoutAccount } from '@Contexts/Settlements/Application/PayoutAccounts';
import { getSuggestedSettlements } from '@Contexts/Settlements/Application/Suggestions';
import { getNetting, netDebts } from '@Contexts/Settlements/Application/Nettings';

/** What a settlement is paid in, as a body gives it: its amount in the group's currency, or what is paid in another (request 12, request 39). */
type SettlementAmountBody = { readonly amount: number } | { readonly original: OriginalBody };

/** What is paid in another currency: its currency and its amount in that currency's hundredths; no rate, which is the service's (request 39). */
type OriginalBody = { readonly currency: string; readonly amount: number };

/** The body of a cash settlement: its shape only; whether the amount is at least 1 and allowed is the domain's (request 12). */
type RecordCashBody = { readonly from: string } & SettlementAmountBody;

/** The body of a payment through the provider: the payee and the amount, shape only (request 13). */
type PayThroughProviderBody = { readonly to: string } & SettlementAmountBody;

/**
 * The schema of what a settlement is paid in (request 39): exactly one of `amount` and `original`, each of the shape it names. A body with
 * neither, or with both, is `400`; whether the currency is one Tally knows, or the amount is allowed, is the domain's.
 */
const exactlyOneAmount = {
  oneOf: [{ required: ['amount'] }, { required: ['original'] }],
};
const amountProperties = {
  amount: { type: 'integer' },
  original: {
    type: 'object',
    required: ['currency', 'amount'],
    properties: { currency: { type: 'string' }, amount: { type: 'integer' } },
  },
};

/** What a body gives of the amount, in the domain's words: the amount, or the original it is paid in (without any rate it may carry). */
const amountOf = (body: SettlementAmountBody): { amount?: number; original?: OriginalBody } =>
  'amount' in body
    ? { amount: body.amount }
    : { original: { currency: body.original.currency, amount: body.original.amount } };

/** The body of a netting: the other member, and the currency, shape only; whether they have anything to net is the domain's (request 32). */
type NetDebtsBody = { readonly with: string; readonly currency: string };

/** The body of a payout account: the provider's id of the account, shape only; whether the provider knows it is the domain's (request 16). */
type SetPayoutAccountBody = { readonly accountId: string };

/** The provider's webhook body: its own id, the payment's id, the status it says, and when it decided it (request 13). */
type PaymentWebhookBody = {
  readonly id: string;
  readonly paymentId: string;
  readonly status: string;
  readonly at: string;
};

/** The body of a fee policy: who bears the provider fee, by name; whether it is one of the three is the domain's (request 38). */
type SetFeePolicyBody = { readonly borneBy: string };

/** A request whose body was kept as it was sent, for the signature of a webhook. */
type RawBodyRequest = FastifyRequest & { rawBody?: string };

/**
 * The settlements' routes: the suggested settlements (request 11, the API's fragment 11), a cash settlement recorded by its payee and
 * read back by a member of its group (request 12, fragment 12), and a payment through the provider with the provider's signed webhook
 * (request 13, fragment 13), a refund of one by its payee (request 15, fragment 15), and a member's payout account at the provider, set and
 * read by its owner (request 16, fragment 16). Each answers its use case at once. A body whose shape is wrong (a missing field, or a value of the wrong
 * type) is `400` before the use case runs. A caller who is not a member of the group gets the group's `404`, and a settlement of a group
 * they are not in does not exist for them. The webhook is the one route anyone may call: its JSON body is kept as it was sent, so that
 * its signature is checked over those very bytes.
 */
export const settlementRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  // A JSON body is parsed as before, and kept as text too: the provider signed the body exactly as it sent it (request 13).
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    (req as RawBodyRequest).rawBody = body;
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return done(Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 }), undefined);
    }
    done(null, value);
  });

  fastify.get<{ Params: { id: string } }>('/groups/:id/settlements/suggested', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getSuggestedSettlements), req.params.id),
  );

  fastify.post<{ Params: { id: string }; Body: RecordCashBody }>(
    '/groups/:id/settlements/cash',
    {
      schema: {
        body: {
          type: 'object',
          required: ['from'],
          properties: { from: { type: 'string' }, ...amountProperties },
          ...exactlyOneAmount,
        },
      },
    },
    (req, reply) =>
      answerAtOnce(
        req,
        reply,
        module.useCase(recordCashSettlement),
        { groupId: req.params.id, from: req.body.from, ...amountOf(req.body) },
        { created: true },
      ),
  );

  fastify.post<{ Params: { id: string }; Body: PayThroughProviderBody }>(
    '/groups/:id/settlements/provider',
    {
      schema: {
        body: {
          type: 'object',
          required: ['to'],
          properties: { to: { type: 'string' }, ...amountProperties },
          ...exactlyOneAmount,
        },
      },
    },
    (req, reply) =>
      answerAtOnce(
        req,
        reply,
        module.useCase(payThroughProvider),
        { groupId: req.params.id, to: req.body.to, ...amountOf(req.body) },
        { created: true },
      ),
  );

  fastify.post<{ Body: PaymentWebhookBody }>(
    '/provider/webhooks',
    {
      schema: {
        body: {
          type: 'object',
          required: ['id', 'paymentId', 'status', 'at'],
          properties: {
            id: { type: 'string' },
            paymentId: { type: 'string' },
            status: { type: 'string' },
            at: { type: 'string' },
          },
        },
      },
    },
    (req, reply) => {
      const signature = req.headers['provider-signature'];
      return answerAtOnce(req, reply, module.useCase(receivePaymentWebhook), {
        body: (req as RawBodyRequest).rawBody ?? '',
        signature: typeof signature === 'string' ? signature : undefined,
        paymentId: req.body.paymentId,
        status: req.body.status,
      });
    },
  );

  fastify.post<{ Params: { id: string } }>('/settlements/:id/refund', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(refundSettlement), req.params.id),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id/settlements', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupSettlements), req.params.id),
  );

  fastify.get<{ Params: { id: string } }>('/settlements/:id', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getSettlement), req.params.id),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id/fee-policy', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getFeePolicy), req.params.id),
  );

  fastify.put<{ Params: { id: string }; Body: SetFeePolicyBody }>(
    '/groups/:id/fee-policy',
    {
      schema: {
        body: {
          type: 'object',
          required: ['borneBy'],
          properties: { borneBy: { type: 'string' } },
        },
      },
    },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(setFeePolicy), { groupId: req.params.id, borneBy: req.body.borneBy }),
  );

  fastify.put<{ Body: SetPayoutAccountBody }>(
    '/accounts/me/payout-account',
    {
      schema: {
        body: {
          type: 'object',
          required: ['accountId'],
          properties: { accountId: { type: 'string' } },
        },
      },
    },
    (req, reply) => answerAtOnce(req, reply, module.useCase(setPayoutAccount), { accountId: req.body.accountId }),
  );

  fastify.get('/accounts/me/payout-account', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getPayoutAccount), undefined),
  );

  fastify.post<{ Body: NetDebtsBody }>(
    '/nettings',
    {
      schema: {
        body: {
          type: 'object',
          required: ['with', 'currency'],
          properties: { with: { type: 'string' }, currency: { type: 'string' } },
        },
      },
    },
    (req, reply) =>
      answerAtOnce(
        req,
        reply,
        module.useCase(netDebts),
        { with: req.body.with, currency: req.body.currency },
        { created: true },
      ),
  );

  fastify.get<{ Params: { id: string } }>('/nettings/:id', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getNetting), req.params.id),
  );

  done();
};
