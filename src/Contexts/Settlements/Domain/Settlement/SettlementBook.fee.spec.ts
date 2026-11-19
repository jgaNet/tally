import { Id } from '@Architecture/Domain';

import { Decision, SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { FeeBorne, payersPartOf, Settlement } from '@Contexts/Settlements/Domain/Settlement/Settlement';

const now = new Date('2026-03-01T10:00:00.000Z');
const payer = new Id('bob');
const payee = new Id('ann');

/** Bob owes Ann `owed`, as Ledger counts it: a negative balance for the payer, a positive one for the payee. */
const decision = (amount: number, owed = 300): Decision => ({
  payer,
  payee,
  paid: { amount },
  payerIsMember: true,
  payeeIsMember: true,
  payerBalance: -owed,
  payeeBalance: owed,
  archived: false,
  suspended: false,
  counterpartyDeleted: false,
});

/** Asks for a payment of `amount` through the provider, on a book whose owner said `borneBy` (or nobody did), and the provider's `fee`. */
const askFor = (amount: number, fee: number, borneBy: FeeBorne | null = null) => {
  const book = SettlementBook.open(new Id('group-1'));
  if (borneBy) {
    const set = book.setFeePolicy({ owner: true, borneBy, archived: false, suspended: false });
    if (set.isFailure()) throw new Error('the owner could not set the policy');
  }
  const planned = book.planPayment({ ...decision(amount), now, payeeAccount: 'acct_ann' });
  if (planned.isFailure()) throw new Error('the payment was refused before the provider');
  const link = { paymentId: 'pay_1', payUrl: 'https://pay.example/pay_1', fee };
  return { book, result: book.recordPayment(planned.data, link, decision(amount)) };
};

describe('the part of the fee the payer bears (request 38)', () => {
  it('is all of it for the payer, none for the payee, and half rounded down when shared', () => {
    expect(payersPartOf({ amount: 31, borneBy: 'payer' })).toBe(31);
    expect(payersPartOf({ amount: 31, borneBy: 'payee' })).toBe(0);
    expect(payersPartOf({ amount: 31, borneBy: 'shared' })).toBe(15);
    expect(payersPartOf({ amount: 30, borneBy: 'shared' })).toBe(15);
  });
});

describe('what a settlement through the provider settles (request 38)', () => {
  it('settles its whole amount when the payee bears the fee', () => {
    const { result } = askFor(300, 31, 'payee');
    expect(result.isFailure()).toBe(false);
    expect(result.data?.settledAmount).toBe(300);
    expect(result.data?.fee).toEqual({ amount: 31, borneBy: 'payee' });
  });

  it('settles its amount less the fee when the payer bears it', () => {
    const { result } = askFor(300, 31, 'payer');
    expect(result.data?.settledAmount).toBe(269);
    expect(result.data?.amount).toBe(300);
  });

  it('settles its amount less the payer half, the payee bearing the extra hundredth, when shared', () => {
    const { result } = askFor(300, 31, 'shared');
    expect(result.data?.settledAmount).toBe(285);
  });

  it('is the payee that bears the fee until the owner says otherwise', () => {
    const { result } = askFor(300, 31);
    expect(result.data?.fee?.borneBy).toBe('payee');
    expect(result.data?.settledAmount).toBe(300);
  });

  it('keeps the fee and who bore it as they were when it was asked for, whatever the owner says afterwards', () => {
    const { book, result } = askFor(300, 31, 'payer');
    expect(book.setFeePolicy({ owner: true, borneBy: 'payee', archived: false, suspended: false }).isFailure()).toBe(
      false,
    );
    expect(result.data?.fee).toEqual({ amount: 31, borneBy: 'payer' });
    expect(result.data?.settledAmount).toBe(269);
  });

  it('counts what it settles while it waits, as what is still owed', () => {
    const { book } = askFor(300, 31, 'payer');
    expect(book.effectiveBalance(payer, -300)).toBe(-31);
    expect(book.effectiveBalance(payee, 300)).toBe(31);
  });

  it('is refused, and nothing is kept, when the provider gives a fee not less than the amount', () => {
    expect(askFor(300, 300).result.isFailure()).toBe(true);
    expect(askFor(300, 301).result.isFailure()).toBe(true);
  });

  it('is refused when the provider gives a fee that is not a whole number, 0 or more', () => {
    expect(askFor(300, -1).result.isFailure()).toBe(true);
    expect(askFor(300, 1.5).result.isFailure()).toBe(true);
  });

  it('settles its amount when the fee is 0', () => {
    expect(askFor(300, 0, 'payer').result.data?.settledAmount).toBe(300);
  });

  it('settles its amount when it has no fee, as a cash settlement does', () => {
    const settlement = new Settlement(new Id('s'), new Id('g'), payer, payee, 300, 'cash', 'paid', now, null, []);
    expect(settlement.settledAmount).toBe(300);
    expect(settlement.fee).toBeNull();
  });
});

describe('who may say who bears the fee (request 38)', () => {
  it('lets the owner say it, and the book reads it back', () => {
    const book = SettlementBook.open(new Id('group-1'));
    expect(book.feePolicy).toBe('payee');
    expect(book.setFeePolicy({ owner: true, borneBy: 'shared', archived: false, suspended: false }).isFailure()).toBe(
      false,
    );
    expect(book.feePolicy).toBe('shared');
  });

  it('refuses any other member', () => {
    const book = SettlementBook.open(new Id('group-1'));
    expect(book.setFeePolicy({ owner: false, borneBy: 'payer', archived: false, suspended: false }).isFailure()).toBe(
      true,
    );
    expect(book.feePolicy).toBe('payee');
  });

  it('refuses a value that is not one of the three', () => {
    const book = SettlementBook.open(new Id('group-1'));
    expect(book.setFeePolicy({ owner: true, borneBy: 'everyone', archived: false, suspended: false }).isFailure()).toBe(
      true,
    );
  });

  it('refuses a change in an archived group, and from a suspended account', () => {
    const book = SettlementBook.open(new Id('group-1'));
    expect(book.setFeePolicy({ owner: true, borneBy: 'payer', archived: true, suspended: false }).isFailure()).toBe(
      true,
    );
    expect(book.setFeePolicy({ owner: true, borneBy: 'payer', archived: false, suspended: true }).isFailure()).toBe(
      true,
    );
  });
});
