import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommandAtOnce, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { AttachReceiptCommandEvent } from '@Contexts/Ledger/Application/Commands';
import { GetReceiptQueryHandler } from '@Contexts/Ledger/Application/Queries';

/**
 * The store is asked at most 5 seconds (request 26); the answer waits a little longer than that, so a store that answers just in
 * time is answered at once, and only a refusal, never a 202, is what a slow store gets.
 */
export const RECEIPT_ANSWER_TIMEOUT_MS = 10_000;

/** The routes of receipts: a member of an expense's group attaches its receipt, and reads it. */
export class FastifyReceiptController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  attachReceipt(req: FastifyRequest<{ Params: { id: string }; Body: Buffer | undefined }>, reply: FastifyReply) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      AttachReceiptCommandEvent.set({ expenseId: req.params.id, bytes: req.body ?? new Uint8Array(0) }),
      { timeoutMs: RECEIPT_ANSWER_TIMEOUT_MS },
    );
  }

  async getReceipt(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetReceiptQueryHandler)
      .handle({ expenseId: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { type: error.type, message: error.message };
  }
}
