import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyReceiptController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyReceiptController';
import {
  AttachReceiptResSchema,
  GetReceiptResSchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/receipt.routes.schema';

/**
 * The transport's ceiling on a receipt's request body, in bytes: above the largest receipt (2 MB) so the domain decides a larger
 * file (refused as InvalidReceipt), and below anything a server would take for a body in full.
 */
export const RECEIPT_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

export const receiptRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifyReceiptController({ module });
  const tags = ['receipts'];

  // A receipt is the file as its body, kept as it was sent: its type is read from its first bytes, never from a header (request 26).
  fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body: Buffer, parsed) => {
    parsed(null, body);
  });

  fastify.put<{ Params: { id: string }; Body: Buffer | undefined }>(
    '/expenses/:id/receipt',
    { bodyLimit: RECEIPT_BODY_LIMIT_BYTES, schema: { tags, response: AttachReceiptResSchema } },
    controller.attachReceipt.bind(controller),
  );

  fastify.get<{ Params: { id: string } }>(
    '/expenses/:id/receipt',
    { schema: { tags, response: GetReceiptResSchema } },
    controller.getReceipt.bind(controller),
  );

  done();
};
