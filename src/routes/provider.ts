import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { isSignedBy, type ProviderConfig } from '../provider';
import { Refusal } from '../refusal';
import { recordProviderOutcome } from '../settlements';

/** The body of a webhook, as the provider sends it; it is read leniently, since the webhook is acknowledged whatever it says. */
function webhookOf(body: Buffer): { paymentId?: unknown; status?: unknown } {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as { paymentId?: unknown; status?: unknown }) : {};
  } catch {
    return {};
  }
}

export function registerProviderRoutes(server: FastifyInstance, db: DatabaseSync, provider: ProviderConfig): void {
  // The signature is over the body exactly as sent, so the body is kept as bytes and parsed only once it is verified.
  // The parser is this scope's alone: the rest of the API keeps its own.
  server.register(async scope => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
    scope.post<{ Body: Buffer | undefined }>('/provider/webhooks', async (request, reply) => {
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const signature = request.headers['provider-signature'];
      if (!isSignedBy(provider.webhookSecret, body, typeof signature === 'string' ? signature : undefined)) {
        throw new Refusal(401, 'SignatureIsInvalid', 'The webhook must carry the provider’s signature of its body.');
      }
      const webhook = webhookOf(body);
      if (typeof webhook.paymentId === 'string' && typeof webhook.status === 'string') {
        recordProviderOutcome(db, { paymentId: webhook.paymentId, status: webhook.status });
      }
      return reply.code(204).send();
    });
  });
}
