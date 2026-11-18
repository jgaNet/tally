import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';

/** A recurring expense of request 23, decided on its own: its values, its day, and what settling a day records. */
const TODAY = new Date('2026-11-18T10:00:00.000Z');
const SETUP: Parameters<typeof RecurringExpense.setUp>[0] = {
  groupId: 'group-1',
  paidBy: 'ana',
  currency: 'EUR',
  description: 'Rent',
  amount: 90_000,
  startsOn: '2026-09-05',
  split: { kind: 'equal', memberIds: ['ana', 'ben'] } as SplitRequest,
  memberIds: ['ana', 'ben'],
  today: TODAY,
};

describe('RecurringExpense (request 23)', () => {
  it('is set up for a day from 1 to 28, no more than 365 days from today, and records its set-up', () => {
    const set = RecurringExpense.setUp(SETUP);

    expect(set.isSuccess()).toBe(true);
    expect(set.data).toMatchObject({ groupId: 'group-1', paidBy: 'ana', startsOn: '2026-09-05', next: '2026-09-05' });
    expect(set.data?.pullDomainEvents()).toHaveLength(1);
  });

  it('refuses a day more than 365 days from today, a day of the month after the 28th, or a day that is not one', () => {
    expect(RecurringExpense.setUp({ ...SETUP, startsOn: '2027-11-20' }).isFailure()).toBe(true);
    expect(RecurringExpense.setUp({ ...SETUP, startsOn: '2025-11-17' }).isFailure()).toBe(true);
    expect(RecurringExpense.setUp({ ...SETUP, startsOn: '2026-11-29' }).isFailure()).toBe(true);
    expect(RecurringExpense.setUp({ ...SETUP, startsOn: '2026-02-30' }).isFailure()).toBe(true);
  });

  it('refuses a split that lists someone who is not a member, or leaves the payer out', () => {
    const stranger = { ...SETUP, split: { kind: 'equal', memberIds: ['ana', 'cy'] } as SplitRequest };
    const withoutPayer = { ...SETUP, split: { kind: 'equal', memberIds: ['ben'] } as SplitRequest };

    expect(RecurringExpense.setUp(stranger).isFailure()).toBe(true);
    expect(RecurringExpense.setUp(withoutPayer).isFailure()).toBe(true);
  });

  it('decides a day not yet come as waiting, and a day that has come as recorded, moving next a month on', () => {
    const set = RecurringExpense.setUp({ ...SETUP, startsOn: '2026-11-18' }).data as RecurringExpense;

    expect(set.settleDay({ today: new Date('2026-11-17T23:00:00.000Z'), memberIds: ['ana', 'ben'] }).kind).toBe(
      'waiting',
    );
    const decided = set.settleDay({ today: TODAY, memberIds: ['ana', 'ben'] });
    expect(decided.kind).toBe('recorded');
    if (decided.kind !== 'recorded') return;
    expect(decided.recurring.next).toBe('2026-12-18');
    const [dayCame] = decided.recurring.pullDomainEvents();
    expect(dayCame.payload).toMatchObject({ date: '2026-11-18', amount: 90_000, paidBy: 'ana', currency: 'EUR' });
  });

  it('ends, and records no expense, when its payer or a member of its split has left', () => {
    const set = RecurringExpense.setUp({ ...SETUP, startsOn: '2026-11-01' }).data as RecurringExpense;

    const decided = set.settleDay({ today: TODAY, memberIds: ['ana'] });
    expect(decided.kind).toBe('ended');
    if (decided.kind !== 'ended') return;
    const events = decided.recurring.pullDomainEvents().map(event => event.constructor.name);
    expect(events).toContain('RecurringExpenseEndedEvent');
    expect(events).not.toContain('RecurringExpenseDayCameEvent');
  });
});
