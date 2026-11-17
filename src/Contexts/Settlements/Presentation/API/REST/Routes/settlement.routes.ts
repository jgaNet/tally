import { FastifyInstance, FastifyRequest } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifySettlementController } from '@Contexts/Settlements/Presentation/API/REST/Controllers/FastifySettlementController';
import { providerSignatureIsValid } from '@Contexts/Settlements/Presentation/API/REST/Routes/provider-signature';
import {
  GetGroupSettlementsResSchema,
  GetPayoutAccountResSchema,
  GetSettlementResSchema,
  GetSuggestedSettlementsResSchema,
  PayThroughProviderBody,
  PayThroughProviderReqBodySchema,
  PayThroughProviderResSchema,
  ProviderWebhookBody,
  ProviderWebhookReqBodySchema,
  ProviderWebhookResSchema,
  RecordCashSettlementBody,
  RecordCashSettlementReqBodySchema,
  RecordCashSettlementResSchema,
  RefundSettlementResSchema,
  SetPayoutAccountBody,
  SetPayoutAccountReqBodySchema,
  SetPayoutAccountResSchema,
} from '@Contexts/Settlements/Presentation/API/REST/Routes/settlement.routes.schema';

/**
 * The routes of settlements. `providerWebhookSecret` is the secret Tally and the provider share, read by the composition root;
 * without it no webhook is signed, and every webhook is refused.
 */
export const settlementRoutes = function (
  fastify: FastifyInstance,
  { module, providerWebhookSecret }: { module: Module; providerWebhookSecret: string },
  done: () => void,
) {
  const controller = new FastifySettlementController({ module });
  const tags = ['settlements'];

  // The provider's webhook is signed over the bytes it was sent in, so this scope keeps the raw body beside the parsed one.
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, parsed) => {
    (req as unknown as { rawBody?: Buffer }).rawBody = body;
    try {
      parsed(null, JSON.parse(body.toString('utf8')));
    } catch {
      parsed(Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 }), undefined);
    }
  });

  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/settlements/suggested',
    { schema: { tags, response: GetSuggestedSettlementsResSchema } },
    controller.getSuggestedSettlements.bind(controller),
  );

  fastify.post<{ Params: { id: string }; Body: RecordCashSettlementBody }>(
    '/groups/:id/settlements/cash',
    { schema: { tags, body: RecordCashSettlementReqBodySchema, response: RecordCashSettlementResSchema } },
    controller.recordCashSettlement.bind(controller),
  );

  fastify.post<{ Params: { id: string }; Body: PayThroughProviderBody }>(
    '/groups/:id/settlements/provider',
    { schema: { tags, body: PayThroughProviderReqBodySchema, response: PayThroughProviderResSchema } },
    controller.payThroughProvider.bind(controller),
  );

  fastify.post<{ Body: ProviderWebhookBody }>(
    '/provider/webhooks',
    {
      schema: { tags, body: ProviderWebhookReqBodySchema, response: ProviderWebhookResSchema },
      // The signature is proved before the body is validated or anything is decided (request 13).
      preValidation: async (req: FastifyRequest, reply) => {
        const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
        const signature = req.headers['provider-signature'];
        if (
          providerSignatureIsValid(
            rawBody,
            typeof signature === 'string' ? signature : undefined,
            providerWebhookSecret,
          )
        ) {
          return;
        }
        return reply.code(401).send({ type: 'NotAllowed', message: 'The provider signature is missing or wrong' });
      },
    },
    controller.receiveProviderWebhook.bind(controller),
  );

  fastify.post<{ Params: { id: string } }>(
    '/settlements/:id/refund',
    { schema: { tags, response: RefundSettlementResSchema } },
    controller.refundSettlement.bind(controller),
  );

  fastify.put<{ Body: SetPayoutAccountBody }>(
    '/accounts/me/payout-account',
    { schema: { tags, body: SetPayoutAccountReqBodySchema, response: SetPayoutAccountResSchema } },
    controller.setPayoutAccount.bind(controller),
  );

  fastify.get(
    '/accounts/me/payout-account',
    { schema: { tags, response: GetPayoutAccountResSchema } },
    controller.getPayoutAccount.bind(controller),
  );

  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/settlements',
    { schema: { tags, response: GetGroupSettlementsResSchema } },
    controller.getGroupSettlements.bind(controller),
  );

  fastify.get<{ Params: { id: string } }>(
    '/settlements/:id',
    { schema: { tags, response: GetSettlementResSchema } },
    controller.getSettlement.bind(controller),
  );

  done();
};
