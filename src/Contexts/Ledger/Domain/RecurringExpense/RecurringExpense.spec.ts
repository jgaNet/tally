import { Id } from '@Architecture/Domain';

import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import {
  RecurringExpenseDayCameEvent,
  RecurringExpenseEndedEvent,
} from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';

const now = new Date('2026-11-18T09:00:00.000Z');
const group = new Id('flat');
const members = ['alice', 'bob', 'carol'].map(id => new Id(id));

const setUp = (overrides: Partial<Parameters<typeof RecurringExpense.setUp>[0]> = {}) =>
  RecurringExpense.setUp({
    groupId: group,
    paidBy: new Id('alice'),
    description: 'Rent',
    amount: 90000,
    startsOn: '2026-09-05',
    split: { kind: 'equal', members: ['alice', 'bob'] },
    groupMembers: members,
    now,
    ...overrides,
  });

describe('RecurringExpense', () => {
  describe('setting up', () => {
    it('keeps its payer, amount and split as given, and its next day is its start day', () => {
      const result = setUp();

      expect(result.isSuccess()).toBe(true);
      expect(result.data).toMatchObject({
        paidBy: { value: 'alice' },
        amount: { value: 90000 },
        startsOn: '2026-09-05',
        next: '2026-09-05',
        split: { kind: 'equal', members: ['alice', 'bob'] },
      });
    });

    it.each([
      ['a day of the 29th or later', '2026-11-29'],
      ['a day that is not real', '2026-02-30'],
      ['a day that is not written YYYY-MM-DD', '5/11/2026'],
    ])('refuses a start on %s', (_, startsOn) => {
      const result = setUp({ startsOn });

      expect(result.isFailure() && result.error.type).toBe('InvalidStartsOn');
    });

    it('refuses a start more than 365 days before or after today, and takes the boundary', () => {
      const tooEarly = setUp({ startsOn: '2025-11-17' });
      const tooLate = setUp({ startsOn: '2027-11-19' });

      expect(tooEarly.isFailure() && tooEarly.error.type).toBe('StartsOnOutOfRange');
      expect(tooLate.isFailure() && tooLate.error.type).toBe('StartsOnOutOfRange');
      expect(setUp({ startsOn: '2025-11-18' }).isSuccess()).toBe(true);
      expect(setUp({ startsOn: '2027-11-18' }).isSuccess()).toBe(true);
    });

    it('refuses a split with a stranger, and a payer who is not in the split, as an expense does', () => {
      const stranger = setUp({ split: { kind: 'equal', members: ['alice', 'dave'] } });
      const notInSplit = setUp({ split: { kind: 'equal', members: ['bob'] } });

      expect(stranger.isFailure() && stranger.error.type).toBe('NotAMemberOfTheGroup');
      expect(notInSplit.isFailure() && notInSplit.error.type).toBe('PayerNotInSplit');
    });
  });

  describe('recording a day', () => {
    it('records the day under a new id it carries, and moves the next day to the same day of the next month', () => {
      const set = setUp().data as RecurringExpense;

      const decided = set.recordDay({ today: '2026-09-05', groupMembers: members });

      expect(decided.isSuccess()).toBe(true);
      expect(decided.data).toMatchObject({ next: '2026-10-05', ended: false });
      const [event] = decided.data!.pullDomainEvents() as RecurringExpenseDayCameEvent[];
      expect(event).toBeInstanceOf(RecurringExpenseDayCameEvent);
      expect(event.payload).toMatchObject({
        recurringExpenseId: set._id.value,
        groupId: 'flat',
        paidBy: 'alice',
        description: 'Rent',
        amount: 90000,
        day: '2026-09-05',
        split: { kind: 'equal', members: ['alice', 'bob'] },
        members: ['alice', 'alice', 'bob'],
      });
      expect(event.payload.expenseId).toEqual(expect.any(String));
    });

    it('is refused for a day that has not come yet', () => {
      const set = setUp().data as RecurringExpense;

      const decided = set.recordDay({ today: '2026-09-04', groupMembers: members });

      expect(decided.isFailure() && decided.error.type).toBe('DayNotYetCome');
    });

    it('ends, and records no expense, when a member of its split has left the group', () => {
      const set = setUp().data as RecurringExpense;

      const decided = set.recordDay({ today: '2026-09-05', groupMembers: [new Id('alice')] });

      expect(decided.isSuccess()).toBe(true);
      expect(decided.data!.ended).toBe(true);
      const events = decided.data!.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(RecurringExpenseEndedEvent);
    });
  });

  describe('stopping', () => {
    it('is refused to a member who is neither its payer nor the owner', () => {
      const set = setUp().data as RecurringExpense;

      const stopped = set.stop({ by: new Id('bob'), byOwner: false });

      expect(stopped.isFailure() && stopped.error.type).toBe('NotThePayerOrTheOwnerOfRecurring');
    });

    it('is allowed to the payer, and to the owner of the group', () => {
      const set = setUp().data as RecurringExpense;

      expect(set.stop({ by: new Id('alice'), byOwner: false }).isSuccess()).toBe(true);
      expect(set.stop({ by: new Id('carol'), byOwner: true }).isSuccess()).toBe(true);
    });
  });
});
