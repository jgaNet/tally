import { SettlementBook, RequestProviderPaymentCommand } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { stillBalance } from '@Contexts/Settlements/Domain/Settlement/StillOwed';

const at = new Date('2026-11-17T10:00:00.000Z');

/** Bob (the payer) pays Ann (the payee) through the provider 30, Bob owing Ann 30 with both members of the group. */
const request = (overrides: Partial<RequestProviderPaymentCommand> = {}): RequestProviderPaymentCommand => ({
  by: 'bob',
  groupCurrency: 'EUR',
  to: 'ann',
  suspended: false,
  payeeDeleted: false,
  amount: 30,
  members: ['ann', 'bob', 'cy'],
  balances: { payer: -30, payee: 30 },
  payoutAccount: 'ann-at-the-provider',
  at,
  archived: false,
  ...overrides,
});

/** A book with one provider settlement of 30 from Bob to Ann pending, its payment `pay-1`, as the store would read it. */
const withPending = () =>
  SettlementBook.fromSnapshot({
    groupId: 'group-1',
    version: 3,
    pending: [{ id: 'settlement-1', from: 'bob', to: 'ann', amount: 30, providerPaymentId: 'pay-1' }],
  });

/** Records the provider settlement of `request()` in a book, with the link the provider gave. */
function requested(book: SettlementBook, command: RequestProviderPaymentCommand = request()) {
  const reserved = book.reserveProviderPayment(command);
  if (reserved.isFailure()) throw reserved.error;
  const recorded = book.recordProviderPayment(command, {
    settlementId: reserved.data.settlementId,
    providerPaymentId: 'pay-1',
    payUrl: 'https://pay.example/pay-1',
    fee: 0,
  });
  if (recorded.isFailure()) throw recorded.error;
  return { settlementId: reserved.data.settlementId, settlement: recorded.data };
}

describe('a settlement through the payment provider', () => {
  it('reserves an id once the rules hold, and records nothing', () => {
    const book = SettlementBook.fromSnapshot({ groupId: 'group-1', version: 0 });
    const reserved = book.reserveProviderPayment(request());
    expect(reserved.isSuccess() && reserved.data.settlementId.length > 0).toBe(true);
    expect(reserved.isSuccess() && reserved.data.payee).toBe('ann-at-the-provider');
    expect(book.recorded).toEqual([]);
    expect(book.pullDomainEvents()).toEqual([]);
  });

  it('records the settlement pending, with the link the provider gave, and says its payment was requested', () => {
    const book = SettlementBook.fromSnapshot({ groupId: 'group-1', version: 0 });
    const { settlementId, settlement } = requested(book);

    expect(settlement).toEqual({
      id: settlementId,
      groupId: 'group-1',
      from: 'bob',
      to: 'ann',
      amount: 30,
      method: 'provider',
      status: 'pending',
      at: at.toISOString(),
      payUrl: 'https://pay.example/pay-1',
      providerPaymentId: 'pay-1',
      settled: 30,
      fee: { amount: 0, borneBy: 'payee' },
    });
    expect(book.recorded).toEqual([settlement]);
    expect(book.pending).toEqual([
      { id: settlementId, from: 'bob', to: 'ann', amount: 30, settled: 30, providerPaymentId: 'pay-1' },
    ]);
    expect(book.pullDomainEvents()).toHaveLength(1);
  });

  it('counts what is waiting as paid: a second request for the same debt is more than is owed', () => {
    const book = withPending();
    // Bob owes 30 and is waiting to pay 30 already: nothing is still owed.
    expect(book.reserveProviderPayment(request()).isFailure()).toBe(true);
    expect(book.reserveProviderPayment(request({ amount: 1 })).isFailure()).toBe(true);
  });

  it('counts what is waiting as paid for the payee too: the same amount is not owed twice', () => {
    const book = SettlementBook.fromSnapshot({
      groupId: 'group-1',
      version: 3,
      pending: [{ id: 's-1', from: 'cy', to: 'ann', amount: 20, providerPaymentId: 'pay-9' }],
    });
    // Ann is owed 30 and 20 of it is waiting to be paid to her: 10 is still owed to her, and Bob owes 30.
    expect(book.reserveProviderPayment(request({ amount: 10, balances: { payer: -30, payee: 30 } })).isSuccess()).toBe(
      true,
    );
    expect(book.reserveProviderPayment(request({ amount: 11, balances: { payer: -30, payee: 30 } })).isFailure()).toBe(
      true,
    );
  });

  it('refuses a payee with no payout account by its name, before the provider is asked, and records nothing', () => {
    const book = SettlementBook.fromSnapshot({ groupId: 'group-1', version: 0 });
    const reserved = book.reserveProviderPayment(request({ payoutAccount: undefined }));
    expect(reserved.isFailure() && reserved.error.type).toBe('PayeeHasNoPayoutAccount');
    expect(book.recorded).toEqual([]);
  });

  it('refuses a payee who is not a member, and paying oneself, as a cash settlement is refused', () => {
    const book = SettlementBook.fromSnapshot({ groupId: 'group-1', version: 0 });
    expect(book.reserveProviderPayment(request({ to: 'dan' })).isFailure()).toBe(true);
    expect(book.reserveProviderPayment(request({ to: 'bob' })).isFailure()).toBe(true);
  });

  it('moves a pending settlement to paid when its payment succeeded, once, and says so', () => {
    const book = withPending();
    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'succeeded', at });

    expect(book.moved).toEqual([{ id: 'settlement-1', status: 'paid', at: at.toISOString() }]);
    expect(book.pending).toEqual([]);
    expect(book.pullDomainEvents()).toHaveLength(1);

    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'failed', at });
    expect(book.moved).toHaveLength(1);
    expect(book.pullDomainEvents()).toHaveLength(0);
  });

  it('moves a pending settlement to failed when its payment failed, and frees what it held', () => {
    const book = withPending();
    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'failed', at });

    expect(book.moved).toEqual([{ id: 'settlement-1', status: 'failed', at: at.toISOString() }]);
    expect(book.pending).toEqual([]);
    expect(book.reserveProviderPayment(request()).isSuccess()).toBe(true);
  });

  it('changes nothing for a pending status, an unknown status, or a payment it does not hold', () => {
    const book = withPending();
    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'pending', at });
    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'chargeback', at });
    book.settleProviderPayment({ providerPaymentId: 'pay-unknown', status: 'succeeded', at });

    expect(book.moved).toEqual([]);
    expect(book.pending).toHaveLength(1);
    expect(book.pullDomainEvents()).toHaveLength(0);
  });

  it('refuses a snapshot whose pending settlement has no payment', () => {
    expect(() =>
      SettlementBook.fromSnapshot({
        groupId: 'group-1',
        version: 1,
        pending: [{ id: 's', from: 'bob', to: 'ann', amount: 30, providerPaymentId: '' }],
      }),
    ).toThrow();
  });
});

describe('what a member still owes or is still owed', () => {
  it('is what the balance says less what is waiting, never past 0, and only on the side it is waiting on', () => {
    // Owing 50, waiting to pay 20: still owes 30.
    expect(stillBalance(-50, { paid: 20, received: 0 })).toBe(-30);
    // Owing 50, waiting to pay 80: owes nothing, not more.
    expect(stillBalance(-50, { paid: 80, received: 0 })).toBe(0);
    // Owed 50, waiting to be paid 20: still owed 30.
    expect(stillBalance(50, { paid: 0, received: 20 })).toBe(30);
    // Owed 50 and waiting to pay: what it pays is not what it is owed, so nothing moves.
    expect(stillBalance(50, { paid: 20, received: 0 })).toBe(50);
    // Owing 50 and waiting to be paid: what is paid to a debtor is not counted against its debt.
    expect(stillBalance(-50, { paid: 0, received: 20 })).toBe(-50);
  });
});
