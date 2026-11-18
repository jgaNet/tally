import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { acceptCommand } from '@Architecture/Presentation/AcceptCommand';
import { AttachReceiptCommandEvent } from '@Contexts/Ledger/Application/Commands/AttachReceipt/AttachReceiptCommandEvent';
import { GetReceiptQueryHandler } from '@Contexts/Ledger/Application/Queries/GetReceipt/GetReceiptQueryHandler';
import { refuse } from '@Contexts/Ledger/Presentation/API/REST/Controllers/refuse';

export class FastifyReceiptController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  attachReceipt(req: FastifyRequest<{ Params: { id: string }; Body: Uint8Array | undefined }>, reply: FastifyReply) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      AttachReceiptCommandEvent.set({ expenseId: req.params.id, bytes: req.body ?? new Uint8Array(0) }),
    );
  }

  async getReceipt(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetReceiptQueryHandler)
      .handle({ expenseId: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }
}
