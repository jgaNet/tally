import { Clock, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';

import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';

/** How many times a recurring expense is read and decided again when another run saved it first; the last conflict is left for the next run. */
const CONFLICT_ATTEMPTS = 3;

/**
 * The background sweep of the recurring expenses (request 23, ADR 14): at each run, it finds the recurring expenses whose day has come
 * by today, and for each records the days that have come, one transaction a day, until none is due: a recurring expense set up with
 * a start long past has each day it has passed recorded at this one run. A day is decided by the recurring expense itself (its
 * payer and split still in the group, or it ends); the expense it records is made by the reaction to `RecurringExpenseDayCame`.
 * Two servers may run the sweep at once: the one that saves a day first wins, and the other reads it again and finds it recorded.
 */
export class RecurringExpenseSweepJob {
  constructor(
    private recurringExpenses: IRecurringExpenseRepository,
    private groupMembers: IGroupMembers,
    private clock: Clock,
  ) {}

  /** One run of the sweep, in the context the process gives it (a unit of work of its own, as a request has). */
  async run(context: ExecutionContext): Promise<void> {
    const today = this.clock().toISOString().slice(0, 10);
    for (const id of await this.recurringExpenses.findDueIds(today)) {
      await this.recordDaysUntilNoneDue(id, today, context);
    }
  }

  private async recordDaysUntilNoneDue(id: Id, today: string, context: ExecutionContext): Promise<void> {
    while ((await this.recordOneDay(id, today, context)) === 'recorded') {
      // one day recorded: the next one that has come is decided in its own transaction
    }
  }

  /** One day, decided in its own transaction; on a conflict it is read and decided again, up to the attempts. */
  private async recordOneDay(id: Id, today: string, context: ExecutionContext): Promise<'recorded' | 'stop'> {
    for (let attempt = 1; ; attempt++) {
      const result = await context.withTransaction(() => this.decideInTransaction(id, today, context));
      if (!result.isFailure()) return result.data;

      const conflict = result.error instanceof ConcurrencyConflictException;
      if (conflict && attempt < CONFLICT_ATTEMPTS) continue;
      context.logger?.warn(`The recurring expense sweep could not decide ${id.value}: ${result.error.message}`, {
        traceId: context.traceId,
      });
      return 'stop';
    }
  }

  private async decideInTransaction(
    id: Id,
    today: string,
    context: ExecutionContext,
  ): Promise<IResult<'recorded' | 'stop'>> {
    const recurring = await this.recurringExpenses.findById(id);
    if (!recurring || !recurring.dayHasCome(today)) return Result.ok('stop');

    const members = await this.groupMembers.membersOf(recurring.groupId.value);
    const decided = recurring.recordDay({ today, groupMembers: members });
    if (decided.isFailure()) return decided;

    if (decided.data.ended) {
      const removed = await this.recurringExpenses.remove(decided.data);
      if (removed.isFailure()) return removed;
      await publishDomainEvents(decided.data, context);
      return Result.ok('stop');
    }
    const saved = await this.recurringExpenses.save(decided.data);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(decided.data, context);
    return Result.ok('recorded');
  }
}
