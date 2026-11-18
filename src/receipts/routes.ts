import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { RECEIPT_MAX_BYTES, type ReceiptsConfig, attachReceipt, requireReceipt } from './receipts';

const receiptSchema = {
  type: 'object',
  required: ['type', 'size', 'url'],
  properties: {
    type: { type: 'string', enum: ['image/jpeg', 'image/png'] },
    size: { type: 'integer', minimum: 1, maximum: RECEIPT_MAX_BYTES },
    url: { type: 'string', minLength: 1 },
  },
};

export function registerReceiptRoutes(app: FastifyInstance, db: Database, receipts: ReceiptsConfig): void {
  // The file is the body, as it is: read whole, and refused when larger than a receipt may be (Fastify answers `413`).
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: RECEIPT_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.put<{ Params: { id: string }; Body: Buffer | undefined }>(
    '/expenses/:id/receipt',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const account = requireAccount(db, request);
      // A request with no body at all is an empty file, which is refused as one.
      await attachReceipt(db, receipts, request.params.id, account.id, request.body ?? Buffer.alloc(0));
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/expenses/:id/receipt',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: receiptSchema },
      },
    },
    async request => {
      const account = requireAccount(db, request);
      return requireReceipt(db, request.params.id, account.id);
    },
  );
}
