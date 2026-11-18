import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import { FastifyReceiptController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyReceiptController';
import {
  AttachReceiptResSchema,
  GetReceiptResSchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/receipt.routes.schema';

/**
 * The transport keeps a receipt's body as it was sent, up to 16 MB: a file larger than the 2 MB the domain allows is refused
 * by the domain behind the 202 (request 26), and only a body beyond this limit is refused by the transport.
 */
const TRANSPORT_LIMIT_BYTES = 16 * 1024 * 1024;

export const receiptRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyReceiptController({ module: ledgerModule });

  // The file is sent as its bytes (`application/octet-stream`), read as they came; its type is the domain's to read.
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: TRANSPORT_LIMIT_BYTES },
    (_req, body, parsed) => parsed(null, body),
  );

  fastify.put(
    '/expenses/:id/receipt',
    { schema: { tags: ['receipts'], response: AttachReceiptResSchema } },
    controller.attachReceipt.bind(controller),
  );
  fastify.get(
    '/expenses/:id/receipt',
    { schema: { tags: ['receipts'], response: GetReceiptResSchema } },
    controller.getReceipt.bind(controller),
  );

  done();
};
