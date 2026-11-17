import { Id } from '@Architecture/Domain';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import {
  InvalidSettlementAmount,
  PayerIsPayee,
  PayerNotAMember,
  SettlementExceedsDebt,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

const at = new Date('2026-01-01T10:00:00.000Z');
const payer = new Id('payer');
const payee = new Id('payee');
const members = ['payer', 'payee'];

function decide(amount: number, balances: Map<string, number>, overrides: { payer?: Id; members?: string[] } = {}) {
  const book = SettlementBook.open(Id.generate(), 0);
  const result = book.recordCash({
    payer: overrides.payer ?? payer,
    payee,
    amount,
    balances,
    members: overrides.members ?? members,
    at,
  });
  return { book, result };
}

describe('SettlementBook: a cash settlement is never more than is owed', () => {
  it('records a settlement up to what the payer owes and what the payee is owed, and records SettlementRecorded', () => {
    const { book, result } = decide(
      30,
      new Map([
        ['payer', -30],
        ['payee', 30],
      ]),
    );

    expect(result.isSuccess()).toBe(true);
    expect(book.decided).toHaveLength(1);
    expect(book.decided[0].amount).toBe(30);
    expect(book.pullDomainEvents()).toHaveLength(1);
  });

  it('refuses more than the payer owes, and records nothing', () => {
    const { book, result } = decide(
      31,
      new Map([
        ['payer', -30],
        ['payee', 40],
      ]),
    );

    expect(result.isFailure() && result.error instanceof SettlementExceedsDebt).toBe(true);
    expect(book.decided).toHaveLength(0);
    expect(book.pullDomainEvents()).toHaveLength(0);
  });

  it('refuses more than the payee is owed', () => {
    const { result } = decide(
      31,
      new Map([
        ['payer', -40],
        ['payee', 30],
      ]),
    );

    expect(result.isFailure() && result.error instanceof SettlementExceedsDebt).toBe(true);
  });

  it('refuses a payee who is owed nothing, and a payer who owes nothing', () => {
    expect(decide(1, new Map([['payer', -30]])).result.isFailure()).toBe(true);
    expect(
      decide(
        1,
        new Map([
          ['payer', 30],
          ['payee', 30],
        ]),
      ).result.isFailure(),
    ).toBe(true);
  });

  it('refuses an amount that is not a whole number of at least 1', () => {
    for (const amount of [0, -5, 1.5]) {
      const { result } = decide(
        amount,
        new Map([
          ['payer', -30],
          ['payee', 30],
        ]),
      );
      expect(result.isFailure() && result.error instanceof InvalidSettlementAmount).toBe(true);
    }
  });

  it('refuses a payer who is the payee, and a payer who is not a member', () => {
    const same = SettlementBook.open(Id.generate(), 0).recordCash({
      payer,
      payee: payer,
      amount: 1,
      balances: new Map([['payer', -30]]),
      members,
      at,
    });
    expect(same.isFailure() && same.error instanceof PayerIsPayee).toBe(true);

    const stranger = decide(
      1,
      new Map([
        ['payer', -30],
        ['payee', 30],
      ]),
      { members: ['payee'] },
    );
    expect(stranger.result.isFailure() && stranger.result.error instanceof PayerNotAMember).toBe(true);
  });
});
