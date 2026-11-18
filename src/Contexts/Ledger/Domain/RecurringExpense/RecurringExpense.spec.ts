import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import { InvalidStartsOnException } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpenseExceptions';

const AT = new Date('2026-11-18T10:00:00Z');
const EQUAL = { kind: 'equal' as const, between: ['ada', 'bob'] };

function setUp(startsOn: string, split = EQUAL) {
  return RecurringExpense.setUp({
    groupId: 'group-1',
    paidBy: 'ada',
    description: 'Rent',
    amount: 90_000,
    startsOn,
    split,
    members: ['ada', 'bob'],
    at: AT,
  });
}

describe('setting up a recurring expense', () => {
  it('is set up on a day of the calendar, its next day being its first', () => {
    const set = setUp('2026-11-05');
    expect(set.isFailure()).toBe(false);
    expect(set.data?.next).toBe('2026-11-05');
  });

  it.each(['2026-11-29', '2026-11-31', '2026-02-30', '2026-13-01'])('refuses the first day %s', startsOn => {
    const set = setUp(startsOn);
    expect(set.isFailure()).toBe(true);
    expect(set.error).toBeInstanceOf(InvalidStartsOnException);
  });

  it('refuses a first day more than 365 days before or after today', () => {
    expect(setUp('2025-11-01').error).toBeInstanceOf(InvalidStartsOnException);
    expect(setUp('2027-12-01').error).toBeInstanceOf(InvalidStartsOnException);
    expect(setUp('2025-11-20').isFailure()).toBe(false);
  });

  it('refuses a split that names someone who is not a member, as an expense does', () => {
    const set = setUp('2026-11-05', { kind: 'equal', between: ['ada', 'cy'] });
    expect(set.isFailure()).toBe(true);
  });
});

describe('running its day', () => {
  it('records the day it had and moves on to the same day of the next month, with the expense it records', () => {
    const set = setUp('2026-12-28');
    const run = set.data!.runDay(['ada', 'bob']);
    expect(run.kind).toBe('recorded');
    expect(run.recurring.next).toBe('2027-01-28');
    const [dayCame] = run.recurring.pullDomainEvents();
    expect(dayCame.name).toBe('RecurringExpenseDayCameEvent');
    expect(dayCame.payload).toMatchObject({ date: '2026-12-28', paidBy: 'ada', amount: 90_000, split: EQUAL });
  });

  it('ends, recording no expense, when a member of its split is no longer a member', () => {
    const set = setUp('2026-12-28');
    const run = set.data!.runDay(['ada']);
    expect(run.kind).toBe('ended');
    // The instance was never saved, so its pending `RecurringExpenseSetUp` is still there, before the ending.
    expect(run.recurring.pullDomainEvents().at(-1)?.name).toBe('RecurringExpenseEndedEvent');
  });
});
