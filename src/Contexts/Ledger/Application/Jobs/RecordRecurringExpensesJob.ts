import { Clock, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';

/**
 * The background job that records the recurring expenses (request 23, ADR 16). Each run finds the recurring expenses whose
 * next day has come, and for each day that has come, from the first one on, decides it in a transaction of its own: the
 * day's fact is stored with the recurring expense's next day, so a day is recorded once whatever the number of servers (a
 * run that loses the race re-reads and decides again, up to three times). A recurring expense whose start has passed gets
 * every day already passed at its run. Nothing is recorded by a request: only the run records. The time is the clock's, given
 * once by the wiring.
 */
export class RecordRecurringExpensesJob {
  static readonly CONFLICT_ATTEMPTS = 3;

  constructor(
    private readonly recurring: IRecurringExpenseRepository,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {}

  async run(context: ExecutionContext): Promise<IResult<unknown>> {
    const at = this.clock();
    const today = at.toISOString().slice(0, 10);
    for (const id of await this.recurring.dueBy(today)) {
      const recorded = await this.recordDue(id, today, at, context);
      if (recorded.isFailure()) {
        context.logger?.warn(`The recurring expense ${id} was not recorded: ${recorded.error.message}`, {
          traceId: context.traceId,
        });
      }
    }
    return Result.ok();
  }

  /** Records the days of one recurring expense that have come, one transaction each, until none is due any more. */
  private async recordDue(id: string, today: string, at: Date, context: ExecutionContext): Promise<IResult<unknown>> {
    for (;;) {
      const step = await this.recordOneDay(id, today, at, context);
      if (step.isFailure() || !step.data.more) return step;
    }
  }

  /** One day, decided in a transaction of its own, again from a fresh read when another run lost the race. */
  private async recordOneDay(
    id: string,
    today: string,
    at: Date,
    context: ExecutionContext,
  ): Promise<IResult<{ more: boolean }>> {
    for (let attempt = 1; ; attempt++) {
      const result = await context.withTransaction(() => this.decideInTransaction(id, today, at, context));
      const conflict = result.isFailure() && result.error instanceof ConcurrencyConflictException;
      if (!conflict || attempt >= RecordRecurringExpensesJob.CONFLICT_ATTEMPTS) return result;
    }
  }

  private async decideInTransaction(
    id: string,
    today: string,
    at: Date,
    context: ExecutionContext,
  ): Promise<IResult<{ more: boolean }>> {
    const found = await this.recurring.findById(new Id(id));
    if (found === null || !found.isDue(today)) return Result.ok({ more: false });

    const members = await this.groupMembers.currentMembers(found.groupId);
    const { recurring } = found.recordDay({ groupMembers: members, at });
    const saved = await this.recurring.save(recurring);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(recurring, context);
    return Result.ok({ more: recurring.isDue(today) });
  }
}
