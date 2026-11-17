import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { IWebhookSignatures } from '@Contexts/Settlements/Application/Ports/IWebhookSignatures';
import { FastifySettlementController } from '@Contexts/Settlements/Presentation/API/REST/Controllers/FastifySettlementController';
import {
  GetSettlementResSchema,
  GetSuggestedSettlementsResSchema,
  LaterCommandResSchema,
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

  fastify.get(
    '/settlements/:id',
    { schema: { tags: ['settlements'], response: GetSettlementResSchema } },
    controller.getSettlement.bind(controller),
  );

  done();
};
