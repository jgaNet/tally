import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { requireMembership } from '../groups/groups';
import { Refusal } from '../refusal';
import { applyProviderStatus, type ProviderConfig, requestProviderSettlement, signatureIsValid } from './provider';
import { contestSettlement } from './contests';
import { requestRefund } from './refunds';
import { recordCashSettlement, requireSettlement, settlementsOfGroup } from './settlements';
import { suggestedTransfersOf } from './suggested';

const transferSchema = {
  type: 'object',
  required: ['from', 'to', 'amount'],
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    amount: { type: 'integer' },
  },
};

export const settlementSchema = {
  type: 'object',
  required: ['id', 'groupId', 'from', 'to', 'amount', 'method', 'status', 'at', 'history'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    amount: { type: 'integer' },
    method: { type: 'string', enum: ['cash', 'provider', 'net'] },
    status: { type: 'string', enum: ['pending', 'paid', 'failed', 'refunding', 'refunded', 'contested', 'annulled'] },
    at: { type: 'string' },
    payUrl: { type: 'string' },
    history: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['status', 'at'],
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'paid', 'failed', 'refunding', 'refunded', 'contested', 'annulled'],
          },
          at: { type: 'string' },
        },
      },
    },
  },
};

const idSchema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

export function registerSettlementRoutes(app: FastifyInstance, db: Database, provider: ProviderConfig): void {
  app.get<{ Params: { id: string } }>(
    '/groups/:id/settlements',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'array', items: settlementSchema } },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      // Only the members of a group see its settlements, those of a member who has left included; anyone
      // else is told it does not exist.
      await requireMembership(db, request.params.id, account.id);
      return await settlementsOfGroup(db, request.params.id);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/groups/:id/settlements/suggested',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'array', items: transferSchema } },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      // Only the members of a group see its suggestions; anyone else is told it does not exist.
      await requireMembership(db, request.params.id, account.id);
      return await suggestedTransfersOf(db, request.params.id);
    },
  );

  app.post<{ Params: { id: string }; Body: { from: string; amount: number } }>(
    '/groups/:id/settlements/cash',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['from', 'amount'],
          properties: { from: { type: 'string' }, amount: { type: 'number' } },
        },
        response: { 201: idSchema },
      },
    },
    async (request, reply) => {
      const account = await requireAccount(db, request);
      // The caller is the payee: the member who was paid in cash records it.
      const id = await recordCashSettlement(db, request.params.id, account.id, {
        from: request.body.from,
        amount: request.body.amount,
      });
      return reply.code(201).send({ id });
    },
  );

  app.post<{ Params: { id: string }; Body: { to: string; amount: number } }>(
    '/groups/:id/settlements/provider',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['to', 'amount'],
          properties: { to: { type: 'string' }, amount: { type: 'number' } },
        },
        response: { 201: idSchema },
      },
    },
    async (request, reply) => {
      const account = await requireAccount(db, request);
      // The caller is the payer: the member who pays the payee through the provider.
      const id = await requestProviderSettlement(
        db,
        provider,
        request.params.id,
        account.id,
        request.body.to,
        request.body.amount,
      );
      return reply.code(201).send({ id });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/settlements/:id/refund',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const account = await requireAccount(db, request);
      // The caller must be the payee: only the member who was paid may refund the payment.
      await requestRefund(db, provider, request.params.id, account.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/settlements/:id/contest',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const account = await requireAccount(db, request);
      // The caller must be the payee: only the member who was paid may say the money did not reach them.
      await contestSettlement(db, request.params.id, account.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/settlements/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: settlementSchema },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      return await requireSettlement(db, request.params.id, account.id);
    },
  );

  // The provider's webhooks. The signature is of the body as sent, so the body is kept as bytes and
  // only read as JSON once it is known to be signed.
  app.register(async webhooks => {
    const keepBytes = (_request: unknown, body: Buffer, done: (error: null, body: Buffer) => void) => done(null, body);
    webhooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, keepBytes);
    webhooks.addContentTypeParser('*', { parseAs: 'buffer' }, keepBytes);

    webhooks.post('/provider/webhooks', async (request, reply) => {
      const body = request.body as Buffer | undefined;
      const signature = request.headers['provider-signature'];
      if (
        body === undefined ||
        !signatureIsValid(provider.webhookSecret, body, typeof signature === 'string' ? signature : undefined)
      ) {
        throw new Refusal(401, 'InvalidSignature', 'The webhook is not signed by the payment provider.');
      }
      // Once signed, it is acknowledged whatever it says: a body that is not an event changes nothing.
      const event = parseEvent(body);
      if (event !== undefined) {
        await applyProviderStatus(db, event.paymentId, event.status);
      }
      return reply.code(204).send();
    });
  });
}

function parseEvent(body: Buffer): { paymentId: string; status: string } | undefined {
  try {
    const event = JSON.parse(body.toString('utf8')) as { paymentId?: unknown; status?: unknown } | null;
    if (typeof event?.paymentId === 'string' && typeof event.status === 'string') {
      return { paymentId: event.paymentId, status: event.status };
    }
  } catch {
    // Not JSON: nothing to apply.
  }
  return undefined;
}
