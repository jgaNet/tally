import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyReceiptController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyReceiptController';
import {
  GetReceiptResSchema,
  LaterCommandResSchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/receipt.routes.schema';

/**
 * The transport's limit on a body: above the receipt's 2 MB, so that a file too large is refused by the receipt behind the 202, as a
 * value of its shape is, and not by the transport. A body larger than this is answered `413` by the transport.
 */
const RECEIPT_BODY_LIMIT = 16 * 1024 * 1024;

export const receiptRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyReceiptController({ module: ledgerModule });

  // The file's bytes as they were sent, for this plugin's routes only: a receipt is the body of its request, not a JSON document.
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: RECEIPT_BODY_LIMIT },
    (_request, body, parsed) => parsed(null, body),
  );

  // Whole paths, registered at the API's root beside the expenses'. Answered 202 and read at the operation (request 26).
  fastify.put(
    '/expenses/:id/receipt',
    { bodyLimit: RECEIPT_BODY_LIMIT, schema: { tags: ['receipts'], response: LaterCommandResSchema } },
    controller.attachReceipt.bind(controller),
  );

  fastify.get(
    '/expenses/:id/receipt',
    { schema: { tags: ['receipts'], response: GetReceiptResSchema } },
    controller.getReceipt.bind(controller),
  );

  done();
};
