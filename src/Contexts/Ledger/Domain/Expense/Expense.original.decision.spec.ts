import { NO_SERVICE } from './Rate';
import { Expense } from './Expense';
import { decideEditExpense, decideRecordExpense, EditExpenseCommand, RecordExpenseCommand } from './Expense.decision';
import { OriginalAmount } from './OriginalAmount';

const ada = 'ada';
const grace = 'grace';
const linus = 'linus';
const now = new Date('2026-11-17T10:00:00Z');
const facts = {
  archived: false,
  suspended: false,
  deleted: false,
  memberIds: [ada, grace, linus],
  groupCurrency: 'EUR',
  offered: NO_SERVICE,
};

const record = (overrides: Partial<RecordExpenseCommand> = {}): RecordExpenseCommand =>
  ({
    description: 'Zurich dinner',
    date: '2026-11-16',
    split: { kind: 'equal', memberIds: [ada, grace, linus] },
    payer: ada,
    original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
    ...overrides,
  }) as RecordExpenseCommand;

describe('recording an expense paid in another currency (request 21)', () => {
  it('counts and splits the amount in the group currency, and keeps what was paid and the rate', () => {
    const decision = decideRecordExpense(facts, record(), now);
    expect(decision.data?.state.amount.value).toBe(1311);
    expect(decision.data?.state.original).toEqual(
      OriginalAmount.create({ currency: 'CHF', amount: 1234, rate: '1.0625' }, 'EUR', NO_SERVICE).data,
    );
    expect(decision.data?.state.split.shares.reduce((sum, share) => sum + share.amount, 0)).toBe(1311);
  });

  it('keeps no original for an expense given in the group currency', () => {
    const decision = decideRecordExpense(facts, record({ original: undefined, amount: 1000 }), now);
    expect(decision.data?.state.amount.value).toBe(1000);
    expect(decision.data?.state.original).toBeUndefined();
  });

  it("refuses the group's own currency, and a converted amount that is not allowed, by name", () => {
    const sameCurrency = decideRecordExpense(
      facts,
      record({ original: { currency: 'EUR', amount: 10, rate: '1' } }),
      now,
    );
    expect(sameCurrency.error?.type).toBe('OriginalCurrencyIsGroupCurrency');
    const tooMuch = decideRecordExpense(
      facts,
      record({ original: { currency: 'USD', amount: 100_000_000, rate: '2' } }),
      now,
    );
    expect(tooMuch.error?.type).toBe('InvalidExpenseAmount');
  });

  it('refuses an original with a rate that is not allowed, before the split is looked at', () => {
    const decision = decideRecordExpense(
      facts,
      record({
        original: { currency: 'CHF', amount: 10, rate: '0' },
        split: { kind: 'equal', memberIds: [ada, 'stranger'] },
      }),
      now,
    );
    expect(decision.error?.type).toBe('InvalidExpenseRate');
  });
});

describe('editing an expense paid in another currency (request 21)', () => {
  it('gives the expense whole again: from an amount to an original, and back', () => {
    const snapshot = {
      id: '6f1d2c3b-0000-4000-8000-000000000002',
      groupId: 'group',
      description: 'Groceries',
      amount: 1000,
      date: '2026-11-16',
      paidBy: ada,
      splitKind: 'equal' as const,
      shares: [
        { memberId: ada, amount: 334 },
        { memberId: grace, amount: 333 },
        { memberId: linus, amount: 333 },
      ],
      category: 'other' as const,
      version: 1,
    };
    const access = {
      archived: false,
      suspended: false,
      deleted: false,
      expense: snapshot,
      memberIds: facts.memberIds,
      ownerId: grace,
      groupCurrency: 'EUR',
      offered: NO_SERVICE,
    };
    const edit = (overrides: Partial<EditExpenseCommand>): EditExpenseCommand =>
      ({
        by: ada,
        description: 'Groceries',
        date: '2026-11-15',
        split: { kind: 'equal', memberIds: [ada, grace, linus] },
        category: 'other' as const,
        version: 1,
        amount: 1000,
        ...overrides,
      }) as EditExpenseCommand;

    const toOriginal = decideEditExpense(
      access,
      edit({ amount: undefined, original: { currency: 'USD', amount: 500, rate: '0.5' } }),
      now,
    );
    expect(toOriginal.data?.state.amount.value).toBe(250);
    expect(toOriginal.data?.state.original?.rate).toBe('0.5');

    const toAmount = decideEditExpense(access, edit({ amount: 900, original: undefined }), now);
    expect(toAmount.data?.state.amount.value).toBe(900);
    expect(toAmount.data?.state.original).toBeUndefined();
  });
});

describe('a stored expense paid in another currency', () => {
  const snapshot = {
    id: '6f1d2c3b-0000-4000-8000-000000000003',
    groupId: 'group',
    description: 'Zurich dinner',
    amount: 1311,
    original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
    date: '2026-11-16',
    paidBy: ada,
    splitKind: 'equal' as const,
    shares: [
      { memberId: ada, amount: 437 },
      { memberId: grace, amount: 437 },
      { memberId: linus, amount: 437 },
    ],
    category: 'other' as const,
    version: 1,
  };

  it('is rebuilt with its original, which it reads back as given', () => {
    expect(Expense.fromSnapshot(snapshot).toSnapshot()).toEqual(snapshot);
  });

  it('is corrupted when its amount in the group currency is not what its original gives', () => {
    expect(() => Expense.fromSnapshot({ ...snapshot, amount: 1312, shares: [] })).toThrow('is corrupted');
  });
});
