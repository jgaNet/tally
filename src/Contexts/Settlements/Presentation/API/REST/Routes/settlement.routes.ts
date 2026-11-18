import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { IWebhookSignatures } from '@Contexts/Settlements/Application/Ports/IWebhookSignatures';
import { FastifySettlementController } from '@Contexts/Settlements/Presentation/API/REST/Controllers/FastifySettlementController';
import {
  GetGroupSettlementsResSchema,
  GetSettlementResSchema,
  GetNettingResSchema,
  DecideContestBodySchema,
  GetContestsResSchema,
  GetSuggestedSettlementsResSchema,
  LaterCommandResSchema,
  NetDebtsBodySchema,
  PayThroughProviderBodySchema,
  ReceivePaymentWebhookBodySchema,
  RecordCashSettlementBodySchema,
} from '@Contexts/Settlements/Presentation/API/REST/Routes/settlement.routes.schema';

export const settlementRoutes = function (
  fastify: FastifyInstance,
  { settlementsModule, webhookSignatures }: { settlementsModule: Module; webhookSignatures: IWebhookSignatures },
  done: () => void,
) {
  const controller = new FastifySettlementController({ module: settlementsModule });

  // The whole paths, registered at the API's root beside the groups', the expenses' and the balances'.
  fastify.get(
    '/groups/:id/settlements/suggested',
    { schema: { tags: ['settlements'], response: GetSuggestedSettlementsResSchema } },
    controller.getSuggested.bind(controller),
  );

  // Answered 202 and read at the operation: a payment in cash the caller received (request 12).
  fastify.post(
    '/groups/:id/settlements/cash',
    { schema: { tags: ['settlements'], body: RecordCashSettlementBodySchema, response: LaterCommandResSchema } },
    controller.recordCash.bind(controller),
  );

  // Answered 202 and read at the operation: a payment through the provider the caller makes (request 13).
  fastify.post(
    '/groups/:id/settlements/provider',
    { schema: { tags: ['settlements'], body: PayThroughProviderBodySchema, response: LaterCommandResSchema } },
    controller.payThroughProvider.bind(controller),
  );

  // Answered 202 and read at the operation: a refund of a payment through the provider, asked by its payee (request 15).
  fastify.post(
    '/settlements/:id/refund',
    { schema: { tags: ['settlements'], response: LaterCommandResSchema } },
    controller.refundSettlement.bind(controller),
  );

  // Answered 202 and read at the operation: what the caller and `with` owe each other, netted across their groups (request 32); the
  // operation's result is the netting's id.
  fastify.post(
    '/nettings',
    { schema: { tags: ['settlements'], body: NetDebtsBodySchema, response: LaterCommandResSchema } },
    controller.netDebts.bind(controller),
  );

  fastify.get(
    '/nettings/:id',
    { schema: { tags: ['settlements'], response: GetNettingResSchema } },
    controller.getNetting.bind(controller),
  );

  // Answered 202 and read at the operation: the payee of a settlement paid through the provider says the money did not arrive (request 33).
  fastify.post(
    '/settlements/:id/contest',
    { schema: { tags: ['settlements'], response: LaterCommandResSchema } },
    controller.contest.bind(controller),
  );

  // Answered 202 and read at the operation: an administrator decides a contested settlement, paid or annulled (request 33).
  fastify.post(
    '/admin/settlements/:id/decision',
    { schema: { tags: ['administration'], body: DecideContestBodySchema, response: LaterCommandResSchema } },
    controller.decideContest.bind(controller),
  );

  // The settlements contested now, the earliest contested first, to an administrator only (request 33).
  fastify.get(
    '/admin/contests',
    { schema: { tags: ['administration'], response: GetContestsResSchema } },
    controller.getContests.bind(controller),
  );

  // The provider's webhook: signed over the body as sent, so the signature is checked before the body is validated or decided
  // (a missing or wrong one is a 401, and nothing changes). Anyone may send it: the signature is the proof.
  fastify.post(
    '/provider/webhooks',
    {
      schema: { tags: ['settlements'], body: ReceivePaymentWebhookBodySchema, response: LaterCommandResSchema },
      preValidation: async (request, reply) => {
        if (!webhookSignatures.isSigned(request.rawBody ?? '', request.headers['provider-signature'] as string)) {
          reply.code(401);
          return reply.send({ message: 'Invalid signature' });
        }
      },
    },
    controller.receivePaymentWebhook.bind(controller),
  );

  // The group's settlements, the most recently recorded first, each with its history (request 19). A whole path, like the group's others.
  fastify.get(
    '/groups/:id/settlements',
    { schema: { tags: ['settlements'], response: GetGroupSettlementsResSchema } },
    controller.getGroupSettlements.bind(controller),
  );

  fastify.get(
    '/settlements/:id',
    { schema: { tags: ['settlements'], response: GetSettlementResSchema } },
    controller.getSettlement.bind(controller),
  );

  done();
};
