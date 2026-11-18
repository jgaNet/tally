import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { requireCaller } from '../http';
import { Refusal } from '../refusal';
import { attachReceipt, MAX_RECEIPT_BYTES, RECEIPT_TYPES, receiptOfMember, type ReceiptsConfig } from '../receipts';

const RECEIPT = {
  type: 'object',
  required: ['type', 'size', 'url'],
  properties: {
    type: { enum: [...RECEIPT_TYPES] },
    size: { type: 'integer' },
    url: { type: 'string' },
  },
};

export function registerReceiptRoutes(server: FastifyInstance, db: DatabaseSync, receipts: ReceiptsConfig): void {
  // The receipt is the file as the body, kept as bytes and read by its first bytes, never parsed. The parser is this
  // scope's alone, and a body over the limit is refused by the server before it is read whole.
  server.register(async scope => {
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_RECEIPT_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );
    // Only the payer or the group's owner attaches a receipt, as they edit the expense; the answer is 204, the expense
    // keeps its version.
    scope.put<{ Params: { id: string }; Body: Buffer | undefined }>('/expenses/:id/receipt', async (request, reply) => {
      const caller = requireCaller(db, request);
      const bytes = request.body ?? Buffer.alloc(0);
      if (!Buffer.isBuffer(bytes)) {
        throw new Refusal(
          415,
          'ReceiptIsNotOctetStream',
          'A receipt is sent as the file itself, as application/octet-stream.',
        );
      }
      await attachReceipt(db, receipts, { expenseId: request.params.id, editorId: caller.id, bytes });
      return reply.code(204).send();
    });
  });

  // Only a member of the expense's group reads its receipt; to anyone else the expense does not exist.
  server.get<{ Params: { id: string } }>(
    '/expenses/:id/receipt',
    { schema: { response: { 200: RECEIPT } } },
    async request => {
      const caller = requireCaller(db, request);
      return receiptOfMember(db, caller.id, request.params.id);
    },
  );
}
