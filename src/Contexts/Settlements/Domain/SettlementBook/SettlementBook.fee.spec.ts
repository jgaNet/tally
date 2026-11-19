import { SettlementBook } from './SettlementBook';

describe('SettlementBook and the provider fee (request 38)', () => {
  const at = new Date('2026-01-01T00:00:00Z');
  const request = (book: SettlementBook, id: string, fee: { amount: number; borneBy: 'payer' | 'payee' | 'shared' }) =>
    book.requestPayment({
      id,
      from: 'grace',
      to: 'ada',
      amount: 300,
      at,
      providerPaymentId: `pay_${id}`,
      payUrl: `https://pay.example/${id}`,
      fee,
    });

  it('keeps the payee as the one who bears the fee until the owner decides, and records FeePolicySet when they do', () => {
    const book = SettlementBook.open('group-1');
    expect(book.feeBorneBy).toBe('payee');
    book.setFeePolicy('payer');
    expect(book.feeBorneBy).toBe('payer');
    expect(book.pullDomainEvents().map(event => event.constructor.name)).toEqual(['FeePolicySetEvent']);
  });

  it('settles what the payer bears of the fee, fixed when the payment is asked for, and counts it as still owed', () => {
    const book = SettlementBook.open('group-1');
    book.setFeePolicy('payer');
    request(book, 's1', { amount: 31, borneBy: 'payer' });
    request(book, 's2', { amount: 31, borneBy: 'payee' });
    book.setFeePolicy('shared');
    expect(book.recorded().map(settlement => [settlement.id, settlement.amount, settlement.settled])).toEqual([
      ['s1', 300, 269],
      ['s2', 300, 300],
    ]);
    // Only the payment still waiting counts as paid for what is owed: 269 of the grace's debt, and 300 is what ada is owed by the two.
    expect(
      book.stillOwed(
        new Map([
          ['grace', -1000],
          ['ada', 1000],
        ]),
      ),
    ).toEqual(
      new Map([
        ['grace', -1000 + 269 + 300],
        ['ada', 1000 - 269 - 300],
      ]),
    );
  });
});
