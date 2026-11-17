import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import {
  FastifySettlementController,
  WebhookRequest,
} from '@Contexts/Settlements/Presentation/API/REST/Controllers/FastifySettlementController';
import {
  GetSettlementResSchema,
  GetSuggestedSettlementsResSchema,
  PayThroughProviderBodySchema,
  PayThroughProviderResSchema,
  ProviderWebhookResSchema,
  RecordCashSettlementBodySchema,
  RecordCashSettlementResSchema,
} from '@Contexts/Settlements/Presentation/API/REST/Routes/settlement.routes.schema';

export const settlementRoutes = function (
  fastify: FastifyInstance,
  { settlementsModule, providerWebhookSecret = '' }: { settlementsModule: Module; providerWebhookSecret?: string },
  done: () => void,
) {
  const controller = new FastifySettlementController({ module: settlementsModule, providerWebhookSecret });

  // The provider's webhook is signed over its body as sent, so the JSON of this plugin's routes is kept as the bytes it came
  // in and parsed without a refusal: a signed webhook is acknowledged whatever it says (ADR 8). The parser is scoped to the
  // settlements' routes, and a route whose body fails its shape is still refused by its schema.
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, parsed) => {
    (req as WebhookRequest).rawBody = body as string;
    try {
      parsed(null, body === '' ? undefined : JSON.parse(body as string));
    } catch {
      parsed(null, undefined);
    }
  });

  fastify.get(
    '/groups/:id/settlements/suggested',
    { schema: { tags: ['settlements'], response: GetSuggestedSettlementsResSchema } },
    controller.getSuggestedSettlements.bind(controller),
  );
  fastify.post(
    '/groups/:id/settlements/cash',
    {
      schema: {
        tags: ['settlements'],
        body: RecordCashSettlementBodySchema,
        response: RecordCashSettlementResSchema,
      },
    },
    controller.recordCashSettlement.bind(controller),
  );
  fastify.post(
    '/groups/:id/settlements/provider',
    {
      schema: {
        tags: ['settlements'],
        body: PayThroughProviderBodySchema,
        response: PayThroughProviderResSchema,
      },
    },
    controller.payThroughProvider.bind(controller),
  );
  fastify.get(
    '/settlements/:id',
    { schema: { tags: ['settlements'], response: GetSettlementResSchema } },
    controller.getSettlement.bind(controller),
  );

  fastify.post(
    '/provider/webhooks',
    { schema: { tags: ['settlements'], response: ProviderWebhookResSchema } },
    controller.receivePaymentWebhook.bind(controller),
  );

  done();
};
