import { NO_SERVICE } from './Rate';
import { decideRecordExpense, RecordExpenseCommand } from './Expense.decision';
import { Split } from './Split';

const ada = 'ada';
const grace = 'grace';
const linus = 'linus';
const members = { memberIds: [ada, grace, linus], groupCurrency: 'EUR', offered: NO_SERVICE };
const now = new Date('2026-11-17T10:00:00Z');

const command = (overrides: Partial<RecordExpenseCommand> = {}): RecordExpenseCommand =>
  ({
    description: 'Groceries',
    amount: 1000,
    date: '2026-11-16',
    split: { kind: 'equal', memberIds: [ada, grace, linus] },
    payer: ada,
    ...overrides,
  }) as RecordExpenseCommand;

describe('the equal split', () => {
  it('gives each member the amount divided by their number, rounded down, the remainder to the first member listed', () => {
    const split = Split.create({
      amount: amountOf(1000),
      request: { kind: 'equal', memberIds: [ada, grace, linus] },
      payer: ada,
    });
    expect(split.data?.shares).toEqual([
      { memberId: ada, amount: 334 },
      { memberId: grace, amount: 333 },
      { memberId: linus, amount: 333 },
    ]);
  });

  it('keeps the order the split was given, and the shares add up to the amount exactly', () => {
    const split = Split.create({
      amount: amountOf(10),
      request: { kind: 'equal', memberIds: [grace, ada, linus] },
      payer: ada,
    });
    expect(split.data?.shares).toEqual([
      { memberId: grace, amount: 4 },
      { memberId: ada, amount: 3 },
      { memberId: linus, amount: 3 },
    ]);
    expect(split.data?.shares.reduce((sum, share) => sum + share.amount, 0)).toBe(10);
  });

  it('refuses a split that lists a member twice, or leaves the payer out', () => {
    expect(
      Split.create({ amount: amountOf(10), request: { kind: 'equal', memberIds: [ada, ada] }, payer: ada }).isFailure(),
    ).toBe(true);
    expect(
      Split.create({
        amount: amountOf(10),
        request: { kind: 'equal', memberIds: [grace, linus] },
        payer: ada,
      }).isFailure(),
    ).toBe(true);
  });
});

describe('deciding an expense', () => {
  it('answers the validated values, with the shares of the split', () => {
    const decision = decideRecordExpense(members, command(), now);
    expect(decision.isSuccess()).toBe(true);
    expect(decision.data?.state.description.value).toBe('Groceries');
    expect(decision.data?.state.split.shares.map(share => share.amount)).toEqual([334, 333, 333]);
  });

  it('trims the description, and refuses one that is only spaces or longer than 100 characters', () => {
    expect(decideRecordExpense(members, command({ description: '  Rent  ' }), now).data?.state.description.value).toBe(
      'Rent',
    );
    expect(decideRecordExpense(members, command({ description: '   ' }), now).error).toMatchObject({
      type: 'InvalidExpenseDescription',
    });
    expect(decideRecordExpense(members, command({ description: 'x'.repeat(101) }), now).error).toMatchObject({
      type: 'InvalidExpenseDescription',
    });
  });

  it('refuses an amount outside 1 to 100 000 000, and one that is not whole', () => {
    for (const amount of [0, -5, 100_000_001, 1.5]) {
      expect(decideRecordExpense(members, command({ amount }), now).error).toMatchObject({
        type: 'InvalidExpenseAmount',
      });
    }
    expect(decideRecordExpense(members, command({ amount: 100_000_000 }), now).isSuccess()).toBe(true);
  });

  it('refuses a date that is not a real day, or is after today in UTC', () => {
    for (const date of ['2026-02-30', '2026-13-01', 'yesterday', '2026-11-18']) {
      expect(decideRecordExpense(members, command({ date }), now).error).toMatchObject({
        type: 'InvalidExpenseDate',
      });
    }
    expect(decideRecordExpense(members, command({ date: '2026-11-17' }), now).isSuccess()).toBe(true);
  });

  it('refuses a split with someone who is not a member of the group', () => {
    expect(
      decideRecordExpense(members, command({ split: { kind: 'equal', memberIds: [ada, 'stranger'] } }), now).error,
    ).toMatchObject({
      type: 'SplitMemberNotInGroup',
    });
  });
});

/** An amount the split is made of, validated the way the decision validates it. */
function amountOf(value: number) {
  const decision = decideRecordExpense(
    members,
    command({ amount: value, split: { kind: 'equal', memberIds: [ada, grace, linus] } }),
    new Date('2026-11-17T10:00:00Z'),
  );
  return decision.data!.state.amount;
}

describe('the category of an expense (request 24)', () => {
  const facts = { memberIds: ['ada', 'grace'], groupCurrency: 'EUR', offered: { kind: 'not-asked' } as never };
  const command = {
    description: 'Market',
    date: '2026-11-17',
    split: { kind: 'equal' as const, memberIds: ['ada', 'grace'] },
    payer: 'ada',
    amount: 1000,
  };
  const at = new Date('2026-11-18T10:00:00Z');

  it('is other when none is given, and the one given when it is one of the eight', () => {
    expect(decideRecordExpense(facts, command, at).data!.state.category).toBe('other');
    expect(decideRecordExpense(facts, { ...command, category: 'travel' }, at).data!.state.category).toBe('travel');
  });

  it('is refused when it is not one of the eight', () => {
    const decision = decideRecordExpense(facts, { ...command, category: 'pets' }, at);
    expect(decision.error!.type).toBe('InvalidExpenseCategory');
  });
});
