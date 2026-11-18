import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

const AT = new Date('2026-11-17T10:00:00.000Z');
const EXPENSE = {
  expenseId: 'pizzas',
  groupId: 'house',
  paidBy: 'bob',
  shares: [
    { memberId: 'bob', amount: 334 },
    { memberId: 'cy', amount: 333 },
    { memberId: 'dee', amount: 333 },
  ],
};

describe('Notice (request 17)', () => {
  it('tells each member of the split but its payer, with their share, once', () => {
    const toTell = Notice.toTellOfExpense({
      ...EXPENSE,
      shares: [...EXPENSE.shares, { memberId: 'cy', amount: 0 }],
      alreadyTold: [],
    });

    expect(toTell).toEqual([
      { memberId: 'cy', amount: 333 },
      { memberId: 'dee', amount: 333 },
    ]);
  });

  it('tells nobody of an expense the payer split with nobody else', () => {
    expect(
      Notice.toTellOfExpense({ ...EXPENSE, shares: [{ memberId: 'bob', amount: 1000 }], alreadyTold: [] }),
    ).toEqual([]);
  });

  it('makes a notice once from the fact: a member who already holds one is not told again', () => {
    expect(Notice.toTellOfExpense({ ...EXPENSE, alreadyTold: ['cy'] })).toEqual([{ memberId: 'dee', amount: 333 }]);
  });

  it('issues a notice of a share, and records NoticeIssued', () => {
    const made = Notice.issue({ recipient: 'cy', groupId: 'house', expenseId: 'pizzas', amount: 333, at: AT });

    expect(made.isSuccess()).toBe(true);
    if (made.isFailure()) return;
    expect(made.data.toSnapshot()).toEqual({
      _id: expect.any(String),
      recipient: 'cy',
      kind: 'expense',
      groupId: 'house',
      expenseId: 'pizzas',
      amount: 333,
      passing: null,
      at: AT,
      version: 0,
    });
    expect(made.data.pullDomainEvents().map(event => event.constructor.name)).toEqual(['NoticeIssuedEvent']);
  });

  it('refuses a share that is not a whole number of cents, as a failed Result', () => {
    const made = Notice.issue({ recipient: 'cy', groupId: 'house', expenseId: 'pizzas', amount: 1.5, at: AT });

    expect(made.isFailure() && made.error.type).toBe('InvalidNotice');
  });

  it('is read back from a snapshot without recording anything, and throws on a corrupted one', () => {
    const snapshot = {
      _id: 'n1',
      recipient: 'cy',
      kind: 'expense' as const,
      groupId: 'house',
      expenseId: 'pizzas',
      amount: 333,
      passing: null,
      at: AT,
      version: 1,
    };

    const notice = Notice.fromSnapshot(snapshot);

    expect(notice.toSnapshot()).toEqual(snapshot);
    expect(notice.pullDomainEvents()).toEqual([]);
    expect(() => Notice.fromSnapshot({ ...snapshot, amount: 1.5 })).toThrow('Corrupted notice n1');
  });
});

describe('Notice of a reminder (request 18)', () => {
  it('is for a member, about a group, for more than 2000 still owed, with no expense', () => {
    const notice = Notice.remind({ recipient: 'cy', groupId: 'house', amount: 2500, at: AT });
    if (notice.isFailure()) throw notice.error;

    expect(notice.data.toSnapshot()).toEqual(
      expect.objectContaining({
        recipient: 'cy',
        kind: 'reminder',
        groupId: 'house',
        expenseId: null,
        amount: 2500,
        at: AT,
      }),
    );
    expect(notice.data.pullDomainEvents().map(event => event.name)).toEqual(['NoticeIssuedEvent']);
  });

  it('refuses a reminder for 2000 or less, for no one, or about no group', () => {
    expect(Notice.remind({ recipient: 'cy', groupId: 'house', amount: 2000, at: AT }).isFailure()).toBe(true);
    expect(Notice.remind({ recipient: '', groupId: 'house', amount: 2500, at: AT }).isFailure()).toBe(true);
    expect(Notice.remind({ recipient: 'cy', groupId: '', amount: 2500, at: AT }).isFailure()).toBe(true);
  });
});
