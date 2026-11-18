import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { attachReceipt, getReceipt } from '@Contexts/Ledger/Application/Receipts';

/**
 * The body limit of a receipt's file, in bytes: 16 MB. A file over the receipt's 2 MB but within this limit reaches the domain and is refused there
 * (`422`, nothing is sent to the store); one over this limit is refused by the transport before any use case runs (`413`).
 */
export const RECEIPT_BODY_LIMIT = 16 * 1024 * 1024;

/**
 * The receipts' routes (request 26, the API's fragment 26): who may edit an expense attaches a receipt to it, the file as the body, and a member
 * of the group reads its type, size and link. The file's body is kept as bytes, as it was sent, for the domain to read its type from; no other
 * content type is parsed here. Each answers its use case at once; the paths are whole, mounted at the root beside the expenses' (ADR 5).
 */
export const receiptRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: RECEIPT_BODY_LIMIT },
    (_req, body: Buffer, parsed) => parsed(null, body),
  );

  fastify.put<{ Params: { id: string }; Body: Buffer }>('/expenses/:id/receipt', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(attachReceipt), { expenseId: req.params.id, bytes: req.body }),
  );

  fastify.get<{ Params: { id: string } }>('/expenses/:id/receipt', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getReceipt), req.params.id),
  );

  done();
};
