import { Id } from '@Architecture/Domain';
import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import { nextMonthDay, StartsOn } from '@Contexts/Ledger/Domain/RecurringExpense/StartsOn';

const today = new Date('2030-03-01T09:00:00Z');

describe('StartsOn', () => {
  test('is a day from the 1st to the 28th of its month, within a year of today', () => {
    expect(StartsOn.create('2030-03-28', today).isFailure()).toBe(false);
    expect(StartsOn.create('2030-03-29', today).isFailure()).toBe(true);
    expect(StartsOn.create('2030-02-30', today).isFailure()).toBe(true);
    expect(StartsOn.create('2031-03-01', today).isFailure()).toBe(false);
    expect(StartsOn.create('2031-03-02', today).isFailure()).toBe(true);
    expect(StartsOn.create('2029-02-28', today).isFailure()).toBe(true);
  });
});

test('the next day is the same day of the next month, the year turning', () => {
  expect(nextMonthDay('2030-03-05')).toBe('2030-04-05');
  expect(nextMonthDay('2030-12-28')).toBe('2031-01-28');
});

describe('RecurringExpense', () => {
  const payer = Id.generate();
  const other = Id.generate();

  function setUp(groupMembers: Id[]) {
    const created = RecurringExpense.setUp({
      groupId: Id.generate(),
      payer,
      description: 'Rent',
      amount: 90000,
      startsOn: '2030-03-05',
      request: { splitBetween: [payer.value, other.value] },
      groupMembers,
      groupArchived: false,
      at: today,
    });
    expect(created.isFailure()).toBe(false);
    return created.isFailure() ? null : created.data;
  }

  test('a day that has come is recorded with an expense identity, and next moves to the next month', () => {
    const recurring = setUp([payer, other]);
    expect(recurring?.isDue('2030-03-05')).toBe(true);
    const { recurring: moved, expenseId } = recurring!.recordDay({ groupMembers: [payer, other], at: today });
    expect(expenseId).not.toBeNull();
    expect(moved.next).toBe('2030-04-05');
    expect(moved.isRemoved).toBe(false);
    expect(moved.isDue('2030-03-31')).toBe(false);
  });

  test('a member of its split who has left ends it, and records no expense for the day', () => {
    const recurring = setUp([payer, other]);
    const { recurring: ended, expenseId } = recurring!.recordDay({ groupMembers: [payer], at: today });
    expect(expenseId).toBeNull();
    expect(ended.isRemoved).toBe(true);
  });

  test('a stop by someone who is neither its payer nor the owner is refused', () => {
    const recurring = setUp([payer, other]);
    expect(recurring!.stop({ by: other, byOwner: false, groupArchived: false, at: today }).isFailure()).toBe(true);
    expect(recurring!.stop({ by: payer, byOwner: false, groupArchived: false, at: today }).isFailure()).toBe(false);
  });

  test('in an archived group, a set-up or a stop is refused by GroupArchived and changes nothing', () => {
    const refused = RecurringExpense.setUp({
      groupId: Id.generate(),
      payer,
      description: 'Rent',
      amount: 90000,
      startsOn: '2030-03-05',
      request: { splitBetween: [payer.value, other.value] },
      groupMembers: [payer, other],
      groupArchived: true,
      at: today,
    });
    expect(refused.isFailure()).toBe(true);
    expect(refused.isFailure() && refused.error.type).toBe('GroupArchived');

    const recurring = setUp([payer, other]);
    const stopped = recurring!.stop({ by: payer, byOwner: true, groupArchived: true, at: today });
    expect(stopped.isFailure()).toBe(true);
    expect(stopped.isFailure() && stopped.error.type).toBe('GroupArchived');
    expect(recurring!.isRemoved).toBe(false);
  });
});
