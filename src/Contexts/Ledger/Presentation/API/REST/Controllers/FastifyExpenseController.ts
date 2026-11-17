import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { acceptCommand } from '@Architecture/Presentation/AcceptCommand';
import {
  DeleteExpenseCommandEvent,
  EditExpenseCommandEvent,
  RecordExpenseCommandEvent,
} from '@Contexts/Ledger/Application/Commands';
import { GetExpenseQueryHandler } from '@Contexts/Ledger/Application/Queries';
import { refuse } from '@Contexts/Ledger/Presentation/API/REST/Controllers/refuse';

export class FastifyExpenseController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  recordExpense(
    req: FastifyRequest<{
      Params: { id: string };
      Body: { description: string; amount: number; date: string; splitBetween: string[] };
    }>,
    reply: FastifyReply,
  ) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      RecordExpenseCommandEvent.set({ groupId: req.params.id, ...req.body }),
    );
  }

  editExpense(
    req: FastifyRequest<{
      Params: { id: string };
      Body: { description: string; amount: number; date: string; splitBetween: string[]; version: number };
    }>,
    reply: FastifyReply,
  ) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      EditExpenseCommandEvent.set({ expenseId: req.params.id, ...req.body }),
    );
  }

  deleteExpense(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, DeleteExpenseCommandEvent.set({ expenseId: req.params.id }));
  }

  async getExpense(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetExpenseQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }
}
