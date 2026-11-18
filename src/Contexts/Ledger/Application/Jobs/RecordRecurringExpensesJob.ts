import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { Clock, ExecutionContext, publishDomainEvents } from '@Architecture/Application';

import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';

/** What one day of one recurring expense came to: a day recorded (more may be due), or nothing more to do with it now. */
type Step = 'recorded' | 'done' | 'failed';

/**
 * The background job that records the days of recurring expenses (request 23). At each run, every recurring expense whose next day
 * has come is decided, day by day: each day in a transaction of its own, where the recurring expense is re-read, decided with the
 * group's members as they are, and saved or removed with what it records, published after the commit. A day that lost a race with
 * another server is decided again, up to three attempts (CONC-OPTIMISTIC). A recurring expense whose days have passed records them
 * all at this run, one fact a day. A failing decision is logged, and the next run tries again. The time is the application's clock,
 * read once per run and handed to the aggregate.
 */
export class RecordRecurringExpensesJob {
  static readonly CONFLICT_ATTEMPTS = 3;

  constructor(
    private recurring: IRecurringExpenseRepository,
    private groupMembers: IGroupMembers,
    private clock: Clock,
  ) {}

  async run(context: ExecutionContext): Promise<void> {
    const at = this.clock();
    for (const due of await this.recurring.dueBy(at)) {
      const id = due._id.value;
      // A day recorded moves the next one on, which may be due too (a startsOn already passed): each is decided in turn.
      let step = await this.stepWithRetries(id, at, context);
      while (step === 'recorded') step = await this.stepWithRetries(id, at, context);
    }
  }

  private async stepWithRetries(id: string, at: Date, context: ExecutionContext): Promise<Step> {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await context.withTransaction(() => this.step(id, at, context));
        if (result.isSuccess()) return result.data;

        const conflict = result.error instanceof ConcurrencyConflictException;
        if (!conflict || attempt >= RecordRecurringExpensesJob.CONFLICT_ATTEMPTS) {
          context.logger?.warn(`Recurring expense ${id} not decided: ${result.error.message}`, {
            traceId: context.traceId,
          });
          return 'failed';
        }
        context.logger?.info(`A recurring expense lost a race (attempt ${attempt} of 3)`, { traceId: context.traceId });
      } catch (error) {
        context.logger?.error(`Recurring expense ${id} failed`, error, { traceId: context.traceId });
        return 'failed';
      }
    }
  }

  private async step(id: string, at: Date, context: ExecutionContext): Promise<IResult<Step>> {
    const recurring = await this.recurring.findById(id);
    if (!recurring) return Result.ok('done');

    const memberIds = await this.groupMembers.currentMemberIds(recurring.groupId);
    const decision = recurring.settleDay({ today: at, memberIds });
    switch (decision.kind) {
      case 'waiting':
        return Result.ok('done');
      case 'ended': {
        const removed = await this.recurring.remove(decision.recurring);
        if (removed.isFailure()) return Result.fail(removed.error);
        await publishDomainEvents(decision.recurring, context);
        return Result.ok('done');
      }
      case 'recorded': {
        const saved = await this.recurring.save(decision.recurring);
        if (saved.isFailure()) return Result.fail(saved.error);
        await publishDomainEvents(decision.recurring, context);
        return Result.ok('recorded');
      }
    }
  }
}
