import { FastifyPluginCallback, FastifyRequest } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { receivePaymentWebhook } from '@Contexts/Settlements/Application/Payments';

/**
 * The payment provider's webhook, at the API's root (request 13, docs/adr/0014): `POST /provider/webhooks`, whose JSON body is `{ id,
 * paymentId, status, at }` and whose `Provider-Signature` header signs the body exactly as sent. The signature is checked over the body
 * as it arrived, so the body is kept as text beside its parsed JSON: this plugin's own JSON parser keeps both, and is in this plugin only.
 *
 * It answers at once: `2xx` once the webhook is acknowledged, `401` when its signature is missing or wrong.
 */
export const providerWebhookRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  const bodies = new WeakMap<FastifyRequest, string>();
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (request, raw, callback) => {
    const body = String(raw); // the bytes as sent, decoded as UTF-8
    bodies.set(request, body);
    try {
      callback(null, JSON.parse(body));
    } catch (error) {
      callback(error as Error, undefined);
    }
  });

  fastify.post<{ Body: { id: string; paymentId: string; status: string; at: string } }>(
    '/provider/webhooks',
    {
      schema: {
        tags: ['settlements'],
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
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(receivePaymentWebhook), {
        body: bodies.get(req) ?? '',
        signature: req.headers['provider-signature'] as string | undefined,
        paymentId: req.body.paymentId,
        status: req.body.status,
      }),
  );

  done();
};
