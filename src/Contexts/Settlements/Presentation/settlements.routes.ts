import { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'stream';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';
import {
  getSettlement,
  getSuggestedSettlements,
  payThroughProvider,
  PayThroughProviderInput,
  receivePaymentWebhook,
  recordCashSettlement,
  RecordCashSettlementInput,
  refundSettlement,
} from '@Contexts/Settlements/Application/Settlements';

const SHAPE_REFUSAL = 'The body must have from (the payer account id, a string) and amount (a whole number)';
const PROVIDER_SHAPE_REFUSAL = 'The body must have to (the payee account id, a string) and amount (a whole number)';
const WEBHOOK_SHAPE_REFUSAL = 'The body must have id, paymentId, status and at, each a string';
/** Whether a webhook's body, as sent, is signed by the provider under the header given: composed at the root, where the secret is read. */
export type ProviderSignatureCheck = (body: Buffer, header: string | undefined) => boolean;

const SIGNATURE_REFUSAL = 'The webhook must be signed by the payment provider';

/** A cash settlement's body: the payer's account id and the amount, each of the type the domain takes (API-BODY-SHAPE). */
const hasShape = (body: unknown): boolean => {
  if (typeof body !== 'object' || body === null) return false;
  const { from, amount } = body as Record<string, unknown>;
  return typeof from === 'string' && Number.isInteger(amount);
};

/** A provider settlement's body: the payee's account id and the amount, each of the type the domain takes (API-BODY-SHAPE). */
const hasProviderShape = (body: unknown): boolean => {
  if (typeof body !== 'object' || body === null) return false;
  const { to, amount } = body as Record<string, unknown>;
  return typeof to === 'string' && Number.isInteger(amount);
};

/** A webhook's body: the provider's four strings, of their types (its status is the domain's to read, and any value is acknowledged). */
const hasWebhookShape = (body: unknown): boolean => {
  if (typeof body !== 'object' || body === null) return false;
  const { id, paymentId, status, at } = body as Record<string, unknown>;
  return [id, paymentId, status, at].every(field => typeof field === 'string');
};

/**
 * Refuses a webhook the provider did not sign with 401 before anything is parsed or decided (request 13, ADR 12): the body is read as
 * it was sent, its signature checked over those bytes, and the same bytes given on to the parser, so the body is parsed as usual.
 */
const signedWebhook =
  (isSigned: ProviderSignatureCheck) =>
  async (request: FastifyRequest, reply: FastifyReply, payload: NodeJS.ReadableStream) => {
    const chunks: Buffer[] = [];
    for await (const chunk of payload) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    if (!isSigned(raw, request.headers['provider-signature'] as string | undefined)) {
      return reply.code(401).send({ type: 'NotAllowed', message: SIGNATURE_REFUSAL });
    }
    return Readable.from([raw]);
  };

/** The settlements' routes, under `/v1` (every route is under the API's prefix, the group's included). */
export const settlementRoutes: FastifyPluginCallback<{
  module: LiteModule;
  providerSignedBy: ProviderSignatureCheck;
}> = (fastify, { module, providerSignedBy }, done) => {
  fastify.get('/groups/:id/settlements/suggested', { schema: { tags: ['settlements'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getSuggestedSettlements), { id: (req.params as { id: string }).id }),
  );

  fastify.post(
    '/groups/:id/settlements/cash',
    {
      schema: { tags: ['settlements'] },
      preValidation: async (request, reply) => {
        if (!hasShape(request.body)) return reply.code(400).send({ message: SHAPE_REFUSAL });
        return undefined;
      },
    },
    (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { from: string; amount: number };
      return answerAtOnce(
        req,
        reply,
        module.useCase(recordCashSettlement),
        { groupId: id, from: body.from, amount: body.amount } as RecordCashSettlementInput,
        { created: true },
      );
    },
  );

  fastify.post(
    '/groups/:id/settlements/provider',
    {
      schema: { tags: ['settlements'] },
      preValidation: async (request, reply) => {
        if (!hasProviderShape(request.body)) return reply.code(400).send({ message: PROVIDER_SHAPE_REFUSAL });
        return undefined;
      },
    },
    (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { to: string; amount: number };
      return answerAtOnce(
        req,
        reply,
        module.useCase(payThroughProvider),
        { groupId: id, to: body.to, amount: body.amount } as PayThroughProviderInput,
        { created: true },
      );
    },
  );

  // The provider's webhook: anyone may send it (the handler says so), and the signature is the proof. Acknowledged with a 2xx whatever
  // it says (request 13), so the provider stops sending it.
  fastify.post(
    '/provider/webhooks',
    {
      schema: { tags: ['settlements'] },
      preParsing: signedWebhook(providerSignedBy),
      preValidation: async (request, reply) => {
        if (!hasWebhookShape(request.body)) return reply.code(400).send({ message: WEBHOOK_SHAPE_REFUSAL });
        return undefined;
      },
    },
    (req, reply) => {
      const body = req.body as { paymentId: string; status: string };
      return answerAtOnce(req, reply, module.useCase(receivePaymentWebhook), {
        paymentId: body.paymentId,
        status: body.status,
      });
    },
  );

  // The payee refunds a settlement paid through the provider; answered at once, `204` (request 15).
  fastify.post('/settlements/:id/refund', { schema: { tags: ['settlements'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(refundSettlement), { id: (req.params as { id: string }).id }),
  );

  fastify.get('/settlements/:id', { schema: { tags: ['settlements'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getSettlement), { id: (req.params as { id: string }).id }),
  );

  done();
};
