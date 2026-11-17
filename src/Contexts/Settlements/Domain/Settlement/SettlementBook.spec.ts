import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

const AT = new Date('2026-11-17T10:00:00.000Z');
const ANN = 'ann';
const BOB = 'bob';
const CY = 'cy';
const MEMBERS = [ANN, BOB, CY];

/** Bob owes Ann 30, and Cy is owed nothing: Ann +30, Bob -30, Cy 0. */
const BALANCES = [
  { memberId: ANN, balance: 30 },
  { memberId: BOB, balance: -30 },
  { memberId: CY, balance: 0 },
];

const recordCash = (book: SettlementBook, overrides: Partial<Parameters<SettlementBook['recordCash']>[0]> = {}) =>
  book.recordCash({ payer: BOB, payee: ANN, amount: 30, at: AT, members: MEMBERS, balances: BALANCES, ...overrides });

describe('SettlementBook', () => {
  it('opens at version 0 with an identity of its own, recording nothing', () => {
    const book = SettlementBook.open('group-1');
    expect(book.version).toBe(0);
    expect(book._id.value).toBeTruthy();
    expect(book.pullDomainEvents()).toEqual([]);
  });

  it('records a settlement the payer owes, and the event SettlementRecorded with it', () => {
    const book = SettlementBook.open('group-1');
    const recorded = recordCash(book);

    expect(recorded.isSuccess()).toBe(true);
    expect(recorded.isSuccess() && recorded.data).toEqual({
      _id: expect.any(String),
      groupId: 'group-1',
      from: BOB,
      to: ANN,
      amount: 30,
      at: '2026-11-17T10:00:00.000Z',
    });
    const events = book.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('SettlementRecordedEvent');
  });

  it('refuses an amount that is not a whole number of at least 1, recording nothing', () => {
    for (const amount of [0, -5, 1.5]) {
      const book = SettlementBook.open('group-1');
      const refused = recordCash(book, { amount });
      expect(refused.isFailure() && refused.error.type).toBe('InvalidSettlementAmount');
      expect(book.pullDomainEvents()).toEqual([]);
      expect(book.toSnapshot().settlements).toEqual([]);
    }
  });

  it('refuses a settlement of a member with themselves', () => {
    const refused = recordCash(SettlementBook.open('group-1'), { payer: ANN, payee: ANN });
    expect(refused.isFailure() && refused.error.type).toBe('SettlementToSelf');
  });

  it('refuses a payer who is not a member of the group', () => {
    const refused = recordCash(SettlementBook.open('group-1'), { payer: 'stranger' });
    expect(refused.isFailure() && refused.error.type).toBe('SettlementPayerNotMember');
  });

  it('refuses more than the payer owes, and more than the payee is owed', () => {
    const overPayer = recordCash(SettlementBook.open('group-1'), { amount: 31 });
    expect(overPayer.isFailure() && overPayer.error.type).toBe('SettlementExceedsBalance');

    // Ann is owed 30 and Bob pays Cy 1: Bob owes 30, but Cy is owed nothing, so nothing may be paid to Cy.
    const toNobody = recordCash(SettlementBook.open('group-1'), { payee: CY, amount: 1 });
    expect(toNobody.isFailure() && toNobody.error.type).toBe('SettlementExceedsBalance');
  });

  it('decides a settlement against the balances it is given: a payer who owes nothing pays nothing', () => {
    const refused = recordCash(SettlementBook.open('group-1'), {
      balances: [
        { memberId: ANN, balance: 0 },
        { memberId: BOB, balance: 0 },
      ],
    });
    expect(refused.isFailure() && refused.error.type).toBe('SettlementExceedsBalance');
  });

  it('rebuilds from a snapshot at the version it was read at, recording nothing', () => {
    const book = SettlementBook.fromSnapshot({ _id: 'book-1', groupId: 'group-1', version: 4 });
    expect(book.version).toBe(4);
    expect(book._id.value).toBe('book-1');
    expect(book.pullDomainEvents()).toEqual([]);
  });
});
