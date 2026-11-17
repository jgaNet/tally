import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { applyPaymentDecision } from './settlements';
import { isValidWebhookSignature, type ProviderConfig } from './provider';
import { Refusal } from './refusal';

/**
 * The provider's webhook: `POST /provider/webhooks`, whose body is `{ id, paymentId, status, at }`, signed in
 * the `Provider-Signature` header. A webhook without a valid signature is refused with `401` and changes
 * nothing. A signed one is acknowledged with `204` whatever it says, so the provider stops sending it; a
 * decision it carries is applied to the settlement of its payment, if Tally has one, as `applyPaymentDecision`
 * applies it: a webhook that comes twice, late, out of order or at once with another changes a payment once.
 *
 * The signature is over the body exactly as it was sent, so this scope reads the body as bytes and parses it
 * only once it is signed. The scope is its own, so that this parser serves this route alone.
 */
export function registerProviderWebhookRoutes(app: FastifyInstance, db: DatabaseSync, provider: ProviderConfig): void {
  app.register(async scope => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

    scope.post('/provider/webhooks', (request, reply) => {
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const signature = request.headers['provider-signature'];
      if (
        !isValidWebhookSignature(provider.webhookSecret, body, typeof signature === 'string' ? signature : undefined)
      ) {
        throw new Refusal(401, 'Unauthorized', 'The webhook is not signed by the payment provider.');
      }
      const event = parseEvent(body);
      if (event) applyPaymentDecision(db, event.paymentId, event.status);
      return reply.code(204).send();
    });
  });
}

/** The payment and the status a signed webhook carries, when its body reads as one; otherwise `undefined`. */
function parseEvent(body: Buffer): { paymentId: string; status: string } | undefined {
  try {
    const event = JSON.parse(body.toString('utf8')) as { paymentId?: unknown; status?: unknown } | null;
    if (typeof event?.paymentId === 'string' && typeof event.status === 'string') {
      return { paymentId: event.paymentId, status: event.status };
    }
  } catch {
    // A signed body that is not JSON is acknowledged all the same: there is nothing in it to apply.
  }
  return undefined;
}
