import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommand, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import { AttachReceiptCommandEvent } from '@Contexts/Ledger/Application/Commands/AttachReceipt';
import { GetReceiptQueryHandler } from '@Contexts/Ledger/Application/Queries/GetReceipt';

export class FastifyReceiptController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  /** The file as it was sent; an empty body is an empty file, which the receipt refuses behind the 202. */
  async attachReceipt(
    req: FastifyRequest<{ Params: { id: string }; Body: Uint8Array | undefined }>,
    reply: FastifyReply,
  ) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      AttachReceiptCommandEvent.set({ expenseId: req.params.id, bytes: req.body ?? new Uint8Array() }),
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

    return { message: error.message };
  }
}
