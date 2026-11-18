import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { attachReceipt, getReceipt } from '@Contexts/Ledger/Application/Receipts';

/**
 * The transport's guard on a receipt's body (request 26): 8 MiB. A receipt is at most 2 MB, and the Receipt refuses the size by name
 * (`ReceiptSizeOutOfRange`); the guard only keeps a body no receipt could be from being read into memory. A body above it is answered `413`
 * before it is read, as any oversized body is.
 */
export const RECEIPT_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * The receipts' routes, at the API's root with their full path (docs/adr/0003, docs/adr/0025): each answers its use case at once. The file is
 * the body of the attach request, `application/octet-stream`, as it was sent: the transport hands its bytes over, and the Receipt reads its type
 * and size from them.
 */
export const receiptRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: RECEIPT_BODY_LIMIT_BYTES },
    (_request, body, next) => next(null, body),
  );

  fastify.put<{ Params: { id: string }; Body: Buffer | undefined }>(
    '/expenses/:id/receipt',
    { bodyLimit: RECEIPT_BODY_LIMIT_BYTES, schema: { tags: ['receipts'] } },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(attachReceipt), {
        expenseId: req.params.id,
        bytes: req.body ?? new Uint8Array(),
      }),
  );

  fastify.get<{ Params: { id: string } }>('/expenses/:id/receipt', { schema: { tags: ['receipts'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getReceipt), { expenseId: req.params.id }),
  );

  done();
};
