import { EventEmitter } from 'events';

import { ExecutionContext } from '@Architecture/Application';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { IResult, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';

import {
  recordRecurringDay,
  setUpRecurringExpense,
  stopRecurringExpense,
  sweepRecurringExpenses,
} from '@Contexts/Ledger/Application/RecurringExpenses';
import { GroupMember, IGroupMembers, PassedBalances } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { RecurringExpenseView } from '@Contexts/Ledger/Domain/RecurringExpense/DTOs';
import { IRecurringExpenseQueries } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseQueries';
import { IRecurringExpenses } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenses';
import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';

/** The day of the run: the job's clock, fixed, so that what has come is known. */
const NOW = new Date('2026-11-18T10:00:00Z');
const clock = () => NOW;

/** The store of recurring expenses, in memory: the aggregates as they were saved. */
class MemoryRecurring implements IRecurringExpenses, IRecurringExpenseQueries {
  readonly rows = new Map<string, RecurringExpense>();

  async get(recurringId: string): Promise<RecurringExpense | undefined> {
    return this.rows.get(recurringId);
  }
  async save(recurring: RecurringExpense): Promise<IResult<undefined>> {
    this.rows.set(recurring.id, recurring);
    return Result.ok(undefined);
  }
  async delete(recurring: RecurringExpense): Promise<IResult<undefined>> {
    this.rows.delete(recurring.id);
    return Result.ok(undefined);
  }
  async findRecurring(recurringId: string): Promise<RecurringExpenseView | undefined> {
    const found = this.rows.get(recurringId);
    return (
      found && {
        id: found.id,
        groupId: found.groupId,
        paidBy: found.paidBy,
        description: '',
        amount: 0,
        startsOn: found.startsOn,
        next: found.next,
        category: 'other',
      }
    );
  }
  async listOf(): Promise<RecurringExpenseView[]> {
    return [];
  }
  async dueOn(day: string): Promise<string[]> {
    return [...this.rows.values()].filter(recurring => recurring.next <= day).map(recurring => recurring.id);
  }
}

/** Ledger's members, in memory: the group's members, with the roles the caller is asked by. */
class MemoryMembers implements IGroupMembers {
  current: string[] = ['ada', 'bob'];
  currentAsked = 0;

  async membersOf(callerId: string): Promise<GroupMember[] | undefined> {
    if (!this.current.includes(callerId)) return undefined;
    return this.current.map((memberId, index) => ({ memberId, role: index === 0 ? 'owner' : 'member' }));
  }

  /** Whether the group is archived: the spec's group never is, unless the spec says so (request 27). */
  archived = false;
  async isArchived(): Promise<boolean> {
    return this.archived;
  }
  async currentMemberIds(): Promise<string[]> {
    this.currentAsked += 1;
    return [...this.current];
  }
  async hasBeenMember(): Promise<boolean> {
    return false;
  }
  async passedBalancesOf(): Promise<PassedBalances | undefined> {
    return undefined;
  }
}

function setUp() {
  const store = new MemoryRecurring();
  const members = new MemoryMembers();
  const context = (subjectId?: string) =>
    new ExecutionContext({
      traceId: 'trace',
      auth: subjectId ? { subjectId, role: Role.USER } : {},
      eventBus: new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock }),
    });
  const setUpUseCase = setUpRecurringExpense(store, members, clock);
  const recordDay = recordRecurringDay(store, members, clock);
  const sweep = (ctx: ExecutionContext) => sweepRecurringExpenses({ queries: store, recordDay, clock }, ctx);
  return { store, members, context, setUp: setUpUseCase, sweep, stop: stopRecurringExpense(store, members) };
}

const EVERY_TWO = { kind: 'equal' as const, between: ['ada', 'bob'] };

describe('the background job, over the recurring expenses', () => {
  it('records each day that has come since the first day, and moves the next day past today', async () => {
    const { store, setUp: set, sweep, context } = setUp();
    const created = await set.run(
      { groupId: 'group-1', description: 'Rent', amount: 90_000, startsOn: '2026-10-01', split: EVERY_TWO },
      context('ada'),
    );
    expect(created.isSuccess()).toBe(true);

    await sweep(context('ada'));

    const [recurring] = [...store.rows.values()];
    // 1 October and 1 November have come by 18 November: both are recorded, the next is 1 December.
    expect(recurring.next).toBe('2026-12-01');
  });

  it('does not read the members for a day that has not come', async () => {
    const { store, members, setUp: set, sweep, context } = setUp();
    await set.run(
      { groupId: 'group-1', description: 'Rent', amount: 90_000, startsOn: '2026-12-01', split: EVERY_TWO },
      context('ada'),
    );

    await sweep(context('ada'));

    expect(members.currentAsked).toBe(0);
    expect([...store.rows.values()][0].next).toBe('2026-12-01');
  });

  it('ends a recurring expense whose split member has left, and records nothing for it', async () => {
    const { store, members, setUp: set, sweep, context } = setUp();
    await set.run(
      { groupId: 'group-1', description: 'Rent', amount: 90_000, startsOn: '2026-10-01', split: EVERY_TWO },
      context('ada'),
    );
    members.current = ['ada'];

    await sweep(context('ada'));

    expect(store.rows.size).toBe(0);
  });

  it('records nothing for a recurring expense that was stopped before its day', async () => {
    const { store, members, setUp: set, stop, sweep, context } = setUp();
    const created = await set.run(
      { groupId: 'group-1', description: 'Rent', amount: 90_000, startsOn: '2026-10-01', split: EVERY_TWO },
      context('ada'),
    );
    const stopped = await stop.run({ id: created.data as string }, context('ada'));
    expect(stopped.isSuccess()).toBe(true);

    await sweep(context('ada'));

    expect(store.rows.size).toBe(0);
    expect(members.currentAsked).toBe(0);
  });

  it("refuses a stop by a member who is neither its payer nor the group's owner", async () => {
    const { setUp: set, stop, context } = setUp();
    const created = await set.run(
      { groupId: 'group-1', description: 'Rent', amount: 90_000, startsOn: '2026-12-01', split: EVERY_TWO },
      context('ada'),
    );
    // Bob is a member, but neither the payer (Ada) nor the group's owner (Ada, first in the group): a refusal.
    const refused = await stop.run({ id: created.data as string }, context('bob'));
    expect(refused.isFailure()).toBe(true);
  });
});
